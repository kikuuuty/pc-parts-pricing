import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogClient, type DefaultCatalog } from '../src/catalog/client';
import { DefaultWarmup } from '../src/scheduler/defaults';
import { harness, ref } from './helpers';
import { POLICY } from '../src/config';

test('Catalog category/default adapter uses only Service Binding and the existing default GET contract', async () => {
  const urls: URL[] = [];
  const client = new CatalogClient({ fetch: (async (url: string) => {
    const u = new URL(url); urls.push(u);
    return Response.json(u.pathname === '/v1/categories' ? { categories: ['cpu', 'gpu', 'cpu'] }
      : { data: [{ ...ref(), category: 'cpu', id: 1 }, { ...ref(), category: 'cpu', id: 1 }],
        meta: { limit: 20, offset: 0, returned: 2 } });
  }) as typeof fetch });
  assert.deepEqual(await client.categories(), ['cpu', 'gpu']);
  assert.deepEqual(await client.defaultRefs('cpu', 20), [ref()]);
  assert(urls.every(u => u.origin === 'https://catalog.internal'));
  assert.equal(urls[1].search, '?category=cpu&limit=20');
});

test('default registration dedupes, preserves existing fresh/unsupported prices and skips unchanged sets', async t => {
  const h = harness(t); const price = h.put(ref()); h.put(ref(3), 'unsupported');
  const catalog: DefaultCatalog = { categories: async () => ['cpu'], defaultRefs: async () => [ref(), ref(2), ref(2), ref(3)] };
  const sync = new DefaultWarmup(h.store, catalog, h.cfg, h.now);
  assert.deepEqual(await sync.sync(), { synced: 1, failed: 0 });
  assert.equal(h.row().is_default, 1); assert.equal(h.row().fetched_at, price.fetched_at);
  assert.equal(h.row(ref(2)).last_requested_at, null); assert.equal(h.row(ref(2)).status, 'pending');
  assert.equal(h.row(ref(3)).status, 'unsupported');
  assert.equal(h.messages.length, 0);
  const before = h.statements.length; h.advance(h.cfg.defaultSyncInterval);
  await sync.sync();
  assert(!h.statements.slice(before).some(s => /UPDATE product_price_summary|DELETE FROM default_warm_ref/.test(s)));
});

test('changing default sets removes membership, preserves summaries and handles a ref shared across categories', async t => {
  const h = harness(t); let pages = { cpu: [ref(1), ref(2)], gpu: [ref(2), ref(3)] };
  let categories = ['cpu', 'gpu'];
  const sync = new DefaultWarmup(h.store, { categories: async () => categories,
    defaultRefs: async category => pages[category as keyof typeof pages] }, h.cfg, h.now);
  await sync.sync();
  pages = { cpu: [ref(4)], gpu: [ref(2), ref(3)] }; h.advance(h.cfg.defaultSyncInterval); await sync.sync();
  assert.equal(h.row(ref(1)).is_default, 0); assert.equal(h.row(ref(2)).is_default, 1);
  assert.equal(h.row(ref(4)).is_default, 1);
  categories = ['cpu']; h.advance(h.cfg.defaultSyncInterval); await sync.sync();
  assert.equal(h.row(ref(2)).is_default, 0); assert.equal(h.row(ref(3)).is_default, 0);
  assert(h.row(ref(1))); assert(h.row(ref(3)));
});

test('Catalog partial failure retains the failed category set and updates successful categories', async t => {
  const h = harness(t); let fail = false;
  const sync = new DefaultWarmup(h.store, { categories: async () => ['cpu', 'gpu'], defaultRefs: async category => {
    if (category === 'gpu' && fail) throw Error('Catalog failed');
    return [ref(category === 'gpu' ? 2 : fail ? 3 : 1)];
  } }, h.cfg, h.now);
  await sync.sync(); fail = true; h.advance(h.cfg.defaultSyncInterval);
  assert.deepEqual(await sync.sync(), { synced: 1, failed: 1 });
  assert.equal(h.row(ref(2)).is_default, 1); assert.equal(h.row(ref(1)).is_default, 0); assert.equal(h.row(ref(3)).is_default, 1);
  fail = false; h.advance(900000); assert.deepEqual(await sync.sync(), { synced: 1, failed: 0 });
});

test('category-list errors preserve registry and replacement transaction rolls back D1 failures', async t => {
  const h = harness(t); let broken = false;
  const sync = new DefaultWarmup(h.store, { categories: async () => { if (broken) throw Error(); return ['cpu']; },
    defaultRefs: async () => [ref()] }, h.cfg, h.now);
  await sync.sync(); broken = true; h.advance(h.cfg.defaultSyncInterval);
  assert.deepEqual(await sync.sync(), { synced: 0, failed: 1 });
  assert.equal(h.row().is_default, 1);
  h.fail(/UPDATE product_price_summary/);
  await assert.rejects(sync.replace('cpu', [ref(2)]));
  assert.equal(h.row().is_default, 1); assert.equal(h.row(ref(2)), undefined);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM default_warm_ref').get()!.n, 1);
});

test('30 categories x 20 refs are resumable and concurrent sync does not duplicate category work', async t => {
  const h = harness(t), calls: string[] = [];
  const catalog: DefaultCatalog = { categories: async () => Array.from({ length: 30 }, (_, i) => `cat_${i}`),
    defaultRefs: async category => { calls.push(category); return Array.from({ length: 20 }, (_, i) => ref(Number(category.split('_')[1]) * 20 + i)); } };
  const sync = new DefaultWarmup(h.store, catalog, h.cfg, h.now);
  for (let i = 0; i < 8; i++) {
    const start = h.statements.length;
    const result = await sync.sync();
    assert(result.synced <= POLICY.syncCategoriesPerTick);
    assert(h.statements.length - start < 50);
    h.advance(900000);
  }
  assert.equal(calls.length, 30); assert.equal(new Set(calls).size, 30);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM product_price_summary WHERE is_default=1').get()!.n, 600);
  assert.equal(h.messages.length, 0);
  assert.deepEqual(await Promise.all([sync.sync(), sync.sync()]), [{ synced: 0, failed: 0 }, { synced: 0, failed: 0 }]);
});

test('malformed/default search errors cannot erase warm membership', async () => {
  for (const body of [null, { data: [], meta: {} }, { data: [{ ...ref(), category: 'gpu' }], meta: { limit: 20, offset: 0, returned: 1 } }]) {
    const client = new CatalogClient({ fetch: (async () => Response.json(body)) as typeof fetch });
    await assert.rejects(client.defaultRefs('cpu', 20));
  }
});

test('obsolete category sync tokens cannot resurrect membership or register new prices', async t => {
  const h = harness(t);
  const sync = new DefaultWarmup(h.store, { categories: async () => ['cpu'], defaultRefs: async () => [ref()] }, h.cfg, h.now);
  await sync.sync();
  const old = h.sqlite.prepare("SELECT token FROM default_warm_category WHERE category='cpu'").get()!.token as string;
  h.sqlite.prepare("UPDATE default_warm_category SET token='new-owner' WHERE category='cpu'").run();
  await sync.replace('cpu', [ref(2)], old);
  assert.equal(h.row().is_default, 1); assert.equal(h.row(ref(2)), undefined);
  h.sqlite.prepare("DELETE FROM default_warm_category WHERE category='cpu'").run();
  await sync.replace('cpu', [ref(3)], old);
  assert.equal(h.row(ref(3)), undefined);
});

test('default membership added during a running cold refresh uses the default price interval on commit', async t => {
  const h = harness(t);
  await h.store.seed([ref()], h.now()); await h.enqueuer.enqueue([ref()], 'cold_warmup');
  const message = h.messages[0], owner = crypto.randomUUID(); await h.store.acquire(message, h.now(), owner);
  await new DefaultWarmup(h.store, { categories: async () => ['cpu'], defaultRefs: async () => [ref()] }, h.cfg, h.now).sync();
  await h.store.finish(message, owner, { status: 'empty', lowest_price: null, offer_count: 0,
    fetched_at: h.now(), expires_at: h.now() + h.cfg.ttl }, h.now() + POLICY.coldInterval, 3, h.now());
  assert.equal(h.row().next_refresh_at, h.now() + POLICY.defaultInterval);
});
