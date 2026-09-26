import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Response as MFResponse, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { body, identifier, ref } from './helpers';
import { LOOKUP_SQL } from '../src/storage/summaries';
import type { ProductSummary } from '../src/pricing/model';

test('workerd: real RPC, D1 migration, Queue consumer and Cron with mocked external boundaries', { timeout: 60000 }, async t => {
  const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm',
    platform: 'browser', external: ['cloudflare:workers'] });
  let providerCalls = 0, catalogCalls = 0, releaseProvider!: () => void;
  const providerBlocked = new Promise<void>(resolve => { releaseProvider = resolve; });
  const mf = new Miniflare(convertV4MiniflareOptions({
    log: new Log(LogLevel.ERROR), cf: false,
    workers: [
      {
        name: 'probe', modules: true, compatibilityDate: '2026-09-26',
        serviceBindings: { PRICING: 'pricing', ADMIN: { name: 'pricing', entrypoint: 'PricingAdmin' } },
        // Only this in-memory test driver has an HTTP-to-RPC adapter.
        script: `export default { async fetch(request, env) {
          const input = await request.json();
          const path = new URL(request.url).pathname;
          const result = path === '/seed' ? await env.ADMIN.seedWarmup(input)
            : path === '/refresh' ? await env.PRICING.requestRefresh(input)
            : await env.PRICING.getPriceSummaries(input);
          return Response.json(result);
        } }`,
      },
      {
        name: 'pricing', modules: true, compatibilityDate: '2026-09-26', script: bundle.outputFiles[0].text,
        d1Databases: { DB: 'test-pricing' }, queueProducers: { REFRESH_QUEUE: 'test-refresh' },
        queueConsumers: { 'test-refresh': { maxBatchSize: 1, maxBatchTimeout: 0, retryDelay: 180, maxRetries: 3 } },
        bindings: { YAHOO_SHOPPING_APP_ID: 'test-only-never-live' },
        serviceBindings: { CATALOG: async request => {
          catalogCalls++;
          if (new URL(request.url).pathname.endsWith('/resolve')) {
            const input = await request.json() as { products: { source: string; upstream_key: string }[] };
            // The real Catalog rejects Queue metadata in a durable reference.
            if (input.products.some(p => Object.keys(p).sort().join(',') !== 'source,upstream_key'))
              return MFResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
            const n = Number(input.products[0].upstream_key.split('-')[1]);
            return MFResponse.json({ products: [{ ...ref(n), id: n, active: true, status: 'active' }] });
          }
          const id = Number(new URL(request.url).pathname.split('/').at(-1));
          return MFResponse.json({ ...ref(id), id, identifiers: id === 1 ? [identifier()] : [] });
        } },
        outboundService: async request => {
          assert.equal(new URL(request.url).hostname, 'shopping.yahooapis.jp');
          providerCalls++;
          await providerBlocked;
          return MFResponse.json(body());
        },
      },
    ],
  }));
  t.after(async () => { releaseProvider(); await mf.dispose(); });
  const db = await mf.getD1Database('DB', 'pricing');
  // Execute the actual migration as individual statements in one D1 batch.
  const migration = readFileSync('migrations/0001_pricing.sql', 'utf8');
  await db.batch(migration.replace(/--[^\n]*/g, '').split(';').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
  const rpc = async (path: string, input: unknown) => {
    const response = await mf.dispatchFetch(`https://test.internal${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    return response.json() as Promise<{ ok: boolean; data: ProductSummary[] & { registered: number; enqueued: number }; error?: { code: string } }>;
  };
  const first = await rpc('/summary', [ref(1), ref(2), ref(1)]);
  assert.equal(first.ok, true);
  assert(first.data.every(p => p.providers.yahoo.status === 'pending'));
  // The response arrived while Yahoo is deliberately blocked.
  releaseProvider();
  const waitFor = async (condition: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await condition()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Queue did not finish');
  };
  await waitFor(async () => (await db.prepare("SELECT COUNT(*) AS n FROM product_price_summary WHERE status IN ('complete','unsupported')").first<{ n: number }>())!.n === 2);
  const warm = await rpc('/summary', [ref(2), ref(1), ref(1)]);
  assert.deepEqual(warm.data.map(p => p.providers.yahoo.status), ['unsupported', 'complete', 'complete']);
  assert.equal(warm.data[1].providers.yahoo.lowest_price, 57800);
  assert.equal(providerCalls, 1); assert.equal(catalogCalls, 4);
  const twenty = Array.from({ length: 20 }, (_, i) => ref(i + 1));
  const lookup = await db.prepare(LOOKUP_SQL).bind(JSON.stringify(twenty)).all();
  assert.equal(lookup.results.length, 20);
  assert.equal(lookup.meta.rows_written, 0);
  assert(lookup.meta.rows_read <= 50);
  t.diagnostic(`D1 batch lookup: rows_read=${lookup.meta.rows_read}, rows_written=${lookup.meta.rows_written}, statements=1`);

  assert.equal((await rpc('/seed', [ref(3), ref(4), ref(5)])).data.registered, 3);
  const worker = await mf.getWorker('pricing');
  await worker.scheduled({ cron: '*/15 * * * *' });
  await waitFor(async () => (await db.prepare("SELECT COUNT(*) AS n FROM product_price_summary WHERE status='unsupported'").first<{ n: number }>())!.n === 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM product_price_summary WHERE status='pending'").first<{ n: number }>())!.n, 2);
  assert.equal(providerCalls, 1);
  assert.equal((await worker.fetch('https://pricing.internal/')).status, 404);
  assert.deepEqual(await rpc('/summary', []), { ok: false, error: { code: 'INVALID_REQUEST' } });
  const warmRefs = Array.from({ length: 20 }, (_, i) => ref(i + 101));
  const now = Date.now();
  await db.batch(warmRefs.map(r => db.prepare(`INSERT INTO product_price_summary
    (source,upstream_key,provider,status,lowest_price,offer_count,fetched_at,expires_at,last_requested_at,next_refresh_at,created_at,updated_at)
    VALUES (?,?,'yahoo','complete',57800,1,?,?,?,?,?,?)`).bind(r.source, r.upstream_key,
      now, now + 21600000, now, now + 21600000, now, now)));
  const warmLookup = await db.prepare(LOOKUP_SQL).bind(JSON.stringify(warmRefs)).all();
  assert.equal(warmLookup.meta.rows_written, 0); assert(warmLookup.meta.rows_read <= 50);
  assert((await rpc('/summary', warmRefs)).data.every(p => p.providers.yahoo.status === 'complete'));
  assert.equal(providerCalls, 1);
  t.diagnostic(`D1 20 warm rows: rows_read=${warmLookup.meta.rows_read}, rows_written=${warmLookup.meta.rows_written}, statements=1`);
  await db.prepare('DROP TABLE product_price_summary').run();
  assert.deepEqual(await rpc('/summary', [ref()]), { ok: false, error: { code: 'PRICING_UNAVAILABLE' } });
});
