import { chunks, DAY, POLICY } from '../config';
import type { ProductRef, RefreshMessage, Resolution, Row } from '../pricing/model';
import { uniqueRefs } from '../pricing/model';

const refSelect = `SELECT json_extract(value,'$.source'), json_extract(value,'$.upstream_key') FROM json_each(?)`;
export const LOOKUP_SQL = `SELECT s.* FROM json_each(?) j LEFT JOIN product_price_summary s
  ON s.source=json_extract(j.value,'$.source') AND s.upstream_key=json_extract(j.value,'$.upstream_key') AND s.provider='yahoo'`;
export const DUE_SQL = `SELECT * FROM product_price_summary INDEXED BY price_refresh_due
  WHERE provider='yahoo' AND is_default=0 AND priority=? AND next_refresh_at<=? ORDER BY next_refresh_at LIMIT ?`;

export class SummaryStore {
  constructor(readonly db: D1Database) {}

  async lookup(refs: ProductRef[]): Promise<Row[]> {
    const rows: Row[] = [];
    for (const part of chunks(uniqueRefs(refs))) {
      const result = await this.db.prepare(LOOKUP_SQL).bind(JSON.stringify(part)).all<Row>();
      rows.push(...result.results.filter(row => row.source !== null));
    }
    return rows;
  }

  async touch(refs: ProductRef[], now: number): Promise<void> {
    for (const part of chunks(uniqueRefs(refs))) await this.touchChunk(part, now);
  }
  private async touchChunk(refs: ProductRef[], now: number): Promise<void> {
    await this.db.prepare(`INSERT INTO product_price_summary
      (source,upstream_key,provider,last_requested_at,access_window_at,access_count,priority,next_refresh_at,created_at,updated_at,queue_lane)
      SELECT json_extract(value,'$.source'),json_extract(value,'$.upstream_key'),'yahoo',?1,?1,1,0,?1,?1,?1,'interactive'
      FROM json_each(?2) WHERE true
      ON CONFLICT(source,upstream_key,provider) DO UPDATE SET
        last_requested_at=?1,
        access_count=CASE WHEN access_window_at<=?3 THEN 1 ELSE MIN(access_count+1,24) END,
        access_window_at=CASE WHEN access_window_at<=?3 THEN ?1 ELSE access_window_at END,
        priority=CASE WHEN status IN ('unsupported','missing') THEN priority ELSE 0 END,
        next_refresh_at=CASE WHEN status IN ('unsupported','missing') THEN next_refresh_at
          ELSE MAX(retry_after,queued_until,MIN(next_refresh_at,COALESCE(expires_at,?1))) END,
        updated_at=?1
      WHERE last_requested_at IS NULL OR last_requested_at<=?4`)
      .bind(now, JSON.stringify(uniqueRefs(refs)), now - DAY, now - POLICY.touchInterval).run();
  }

  async seed(refs: ProductRef[], now: number): Promise<number> {
    let count = 0;
    for (const part of chunks(uniqueRefs(refs))) count += await this.seedChunk(part, now);
    return count;
  }
  private async seedChunk(refs: ProductRef[], now: number): Promise<number> {
    const result = await this.db.prepare(`INSERT INTO product_price_summary
      (source,upstream_key,provider,next_refresh_at,created_at,updated_at)
      SELECT json_extract(value,'$.source'),json_extract(value,'$.upstream_key'),'yahoo',?,?,?
      FROM json_each(?) WHERE true ON CONFLICT DO NOTHING RETURNING source`)
      .bind(now, now, now, JSON.stringify(uniqueRefs(refs))).all();
    return result.results.length;
  }

  async claim(refs: ProductRef[], now: number, token: string, scheduled: boolean): Promise<Row[]> {
    const rows: Row[] = [];
    for (const part of chunks(uniqueRefs(refs))) rows.push(...await this.claimChunk(part, now, token, scheduled));
    return rows;
  }
  private async claimChunk(refs: ProductRef[], now: number, token: string, scheduled: boolean): Promise<Row[]> {
    const result = await this.db.prepare(`UPDATE product_price_summary SET
      queue_token=?1,queued_until=?2,next_refresh_at=?2,run_token=NULL,run_until=0,updated_at=?3,
      queue_lane='${scheduled ? 'background' : 'interactive'}'
      WHERE provider='yahoo' AND (source,upstream_key) IN (${refSelect.replace('?', '?4')})
        AND (queued_until<=?3 ${scheduled ? '' : "OR queue_lane='background'"}) AND run_until<=?3 AND retry_after<=?3
        AND (expires_at IS NULL OR expires_at<=?3)
        AND ${scheduled ? 'next_refresh_at<=?3' : "status!='unsupported'"}
      RETURNING *`).bind(token, now + POLICY.queueLease, now, JSON.stringify(uniqueRefs(refs))).all<Row>();
    return result.results;
  }

  async release(message: RefreshMessage, next: number, now: number): Promise<void> {
    await this.db.prepare(`UPDATE product_price_summary SET queue_token=NULL,queued_until=0,
      next_refresh_at=?,retry_after=?,updated_at=?
      WHERE source=? AND upstream_key=? AND provider=? AND queue_token=? AND run_token IS NULL`)
      .bind(next, next, now, message.source, message.upstream_key, message.provider, message.token).run();
  }

  async releaseBatch(messages: RefreshMessage[], next: number, now: number): Promise<void> {
    for (const part of chunks(messages)) await this.db.prepare(`UPDATE product_price_summary
      SET queue_token=NULL,queued_until=0,next_refresh_at=?1,retry_after=?1,updated_at=?2
      WHERE provider='yahoo' AND (source,upstream_key,queue_token) IN
        (SELECT json_extract(value,'$.source'),json_extract(value,'$.upstream_key'),json_extract(value,'$.token') FROM json_each(?3))
      AND run_token IS NULL`).bind(next, now, JSON.stringify(part)).run();
  }

  async acquire(message: RefreshMessage, now: number, runToken: string): Promise<Row | null> {
    return this.db.prepare(`UPDATE product_price_summary SET run_token=?,run_until=?,updated_at=?
      WHERE source=? AND upstream_key=? AND provider=? AND queue_token=? AND run_until<=?
      RETURNING *`).bind(runToken, now + POLICY.runLease, now, message.source, message.upstream_key,
      message.provider, message.token, now).first<Row>();
  }

  async finish(message: RefreshMessage, runToken: string, result: Resolution,
    next: number, priority: number, now: number): Promise<boolean> {
    const saved = await this.db.prepare(`UPDATE product_price_summary SET status=?,lowest_price=?,offer_count=?,
      fetched_at=?,expires_at=?,next_refresh_at=CASE WHEN is_default=1 AND ? IN ('complete','empty')
        THEN MAX(?,?) ELSE ? END,priority=?,updated_at=?,failure_count=0,last_error=NULL,
      queue_token=NULL,queued_until=0,run_token=NULL,run_until=0,retry_after=0
      WHERE source=? AND upstream_key=? AND provider=? AND queue_token=? AND run_token=? RETURNING source`)
      .bind(result.status, result.lowest_price, result.offer_count, result.fetched_at, result.expires_at,
        result.status, result.expires_at, now + POLICY.defaultInterval,
        next, priority, now, message.source, message.upstream_key, message.provider, message.token, runToken).first();
    return saved !== null;
  }

  async fail(message: RefreshMessage, runToken: string, reason: string, next: number, now: number): Promise<void> {
    await this.db.prepare(`UPDATE product_price_summary SET last_error=?,failure_count=MIN(failure_count+1,16),
      next_refresh_at=?,retry_after=?,updated_at=?,queue_token=NULL,queued_until=0,run_token=NULL,run_until=0
      WHERE source=? AND upstream_key=? AND provider=? AND queue_token=? AND run_token=?`)
      .bind(reason, next, next, now, message.source, message.upstream_key, message.provider, message.token, runToken).run();
  }

  async due(priority: number, now: number, limit: number): Promise<Row[]> {
    if (limit <= 0) return [];
    return (await this.db.prepare(DUE_SQL).bind(priority, now, limit).all<Row>()).results;
  }

  async defaultDue(now: number, limit: number): Promise<Row[]> {
    if (limit <= 0) return [];
    return (await this.db.prepare(`SELECT * FROM product_price_summary INDEXED BY price_default_due
      WHERE provider='yahoo' AND is_default=1 AND next_refresh_at<=? ORDER BY next_refresh_at LIMIT ?`)
      .bind(now, limit).all<Row>()).results;
  }
}
