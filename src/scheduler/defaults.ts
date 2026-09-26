import { chunks, POLICY, type Config } from '../config';
import type { DefaultCatalog } from '../catalog/client';
import { refKey, uniqueRefs, type ProductRef } from '../pricing/model';
import type { SummaryStore } from '../storage/summaries';

export interface SyncResult { synced: number; failed: number }

export class DefaultWarmup {
  constructor(private store: SummaryStore, private catalog: DefaultCatalog, private cfg: Config, private now = Date.now) {}

  // A resumable four-category slice each Cron, not 30 fan-outs in one Free invocation.
  // Each category keeps its previous set on failure and retries at a later tick.
  async sync(): Promise<SyncResult> {
    const db = this.store.db, now = this.now();
    const listClaim = await db.prepare(`UPDATE work_budget SET next_allowed_at=? WHERE name='default_sync'
      AND next_allowed_at<=? RETURNING name`).bind(now + this.cfg.defaultSyncInterval, now).first();
    if (listClaim) {
      try {
        const categories = await this.catalog.categories();
        // Retain old categories until bounded empty-set cleanup succeeds. Avoid a
        // catalog-sized summary UPDATE; list failure must preserve every old set.
        await db.prepare(`INSERT INTO default_warm_category(category)
          SELECT value FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`).bind(JSON.stringify(categories)).run();
        const old = (await db.prepare('SELECT category FROM default_warm_category').all<{ category: string }>()).results;
        const removed = old.filter(c => !categories.includes(c.category)).slice(0, POLICY.syncCategoriesPerTick);
        for (const { category } of removed) {
          // Fence a search already running for this removed category before reading
          // its previous membership; it must not resurrect refs after cleanup.
          const removalToken = crypto.randomUUID();
          await db.prepare('UPDATE default_warm_category SET token=?,next_sync_at=? WHERE category=?')
            .bind(removalToken, now + this.cfg.defaultSyncInterval, category).run();
          await this.replace(category, [], removalToken);
          await db.prepare('DELETE FROM default_warm_category WHERE category=? AND token=?').bind(category, removalToken).run();
        }
        if (removed.length) return { synced: removed.length, failed: 0 };
      } catch {
        await db.prepare("UPDATE work_budget SET next_allowed_at=? WHERE name='default_sync'").bind(now + 900_000).run();
        return { synced: 0, failed: 1 };
      }
    }
    const token = crypto.randomUUID();
    const categories = (await db.prepare(`UPDATE default_warm_category SET next_sync_at=?,token=?
      WHERE category IN (SELECT category FROM default_warm_category INDEXED BY default_category_due
        WHERE next_sync_at<=? ORDER BY next_sync_at LIMIT ?) RETURNING category`)
      .bind(now + this.cfg.defaultSyncInterval, token, now, POLICY.syncCategoriesPerTick).all<{ category: string }>()).results;
    let synced = 0, failed = 0;
    for (const { category } of categories) {
      try {
        const refs = await this.catalog.defaultRefs(category, this.cfg.defaultPageSize);
        await this.replace(category, refs, token);
        synced++;
      } catch {
        failed++;
        await db.prepare('UPDATE default_warm_category SET next_sync_at=? WHERE category=? AND token=?')
          .bind(now + 900_000, category, token).run();
      }
    }
    return { synced, failed };
  }

  async replace(category: string, refs: ProductRef[], token?: string): Promise<void> {
    const db = this.store.db, now = this.now(), products = uniqueRefs(refs);
    const previous = (await db.prepare('SELECT source,upstream_key FROM default_warm_ref WHERE category=?')
      .bind(category).all<ProductRef>()).results;
    if (previous.length === products.length && previous.every(p => products.some(r => refKey(r) === refKey(p)))) return;
    // One atomic category replacement. Existing summaries/prices/access data survive.
    const json = JSON.stringify(products), affected = uniqueRefs([...previous, ...products]);
    const guard = `EXISTS (SELECT 1 FROM default_warm_category WHERE category=?1 AND (?2 IS NULL OR token=?2))`;
    await db.batch([
      db.prepare(`INSERT INTO product_price_summary(source,upstream_key,provider,next_refresh_at,created_at,updated_at)
        SELECT json_extract(value,'$.source'),json_extract(value,'$.upstream_key'),'yahoo',?4,?4,?4
        FROM json_each(?3) WHERE ${guard} ON CONFLICT DO NOTHING`).bind(category, token ?? null, json, now),
      db.prepare(`DELETE FROM default_warm_ref WHERE category=?1 AND ${guard}`).bind(category, token ?? null),
      db.prepare(`INSERT INTO default_warm_ref(category,source,upstream_key)
        SELECT ?1,json_extract(value,'$.source'),json_extract(value,'$.upstream_key') FROM json_each(?3)
        WHERE ${guard}`).bind(category, token ?? null, json),
      ...[...chunks(affected)].map(part => db.prepare(`UPDATE product_price_summary SET is_default=EXISTS
        (SELECT 1 FROM default_warm_ref d WHERE d.source=product_price_summary.source AND d.upstream_key=product_price_summary.upstream_key),
        priority=CASE WHEN last_requested_at IS NULL THEN 3 ELSE priority END,
        next_refresh_at=CASE WHEN is_default=0 AND status NOT IN ('unsupported','missing')
          THEN MAX(retry_after,queued_until,COALESCE(expires_at,?4)) ELSE next_refresh_at END
        WHERE provider='yahoo' AND (source,upstream_key) IN
          (SELECT json_extract(value,'$.source'),json_extract(value,'$.upstream_key') FROM json_each(?3)) AND ${guard}`)
        .bind(category, token ?? null, JSON.stringify(part), now)),
    ]);
  }
}
