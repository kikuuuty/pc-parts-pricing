import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, TARGET, runSmoke, validate, type Options } from '../scripts/smoke-pricing';
import { ref } from './helpers';
import type { PricingRpc } from '../src/pricing/contracts';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const options: Options = { production: false, polls: 8, intervalMs: 10000, durationMs: 120000, duplicatePending: false };
const live = { ...options, production: true, confirm: `${TARGET.service}@${TARGET.account}` };
function harness(status = 'pending', stale = false) {
  let now = 0, connects = 0, calls = 0, disposed = 0;
  const events: unknown[] = [], sleeps: number[] = [];
  let impl = async () => ({ ok: true, data: [{ ...ref(), providers: { yahoo: {
    provider: 'yahoo', status, stale, lowest_price: null, offer_count: null, fetched_at: null, expires_at: null,
  } } }] });
  const deps = { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; },
    emit: (e: unknown) => events.push(e), connect: async () => {
      connects++; return { rpc: { getPriceSummaries: async () => { calls++; return impl(); } } as unknown as PricingRpc,
        dispose: async () => { disposed++; } };
    } };
  return { deps, events, sleeps, counts: () => ({ connects, calls, disposed }),
    set: (fn: typeof impl) => { impl = fn; }, advance: (ms: number) => { now += ms; } };
}
test('Pricing smoke dry-run does not connect, poll, authenticate or invoke RPC', async () => {
  const h = harness();
  assert.equal(await runSmoke([ref()], options, h.deps), 'dry-run');
  assert.deepEqual(h.counts(), { connects: 0, calls: 0, disposed: 0 }); assert.equal(h.sleeps.length, 0);
});
test('Pricing smoke validates refs, duplicates, confirmation and test-only count limit', () => {
  for (const input of [[], null, [1], [{ ...ref(), id: 1 }], [ref(), ref()],
    Array.from({ length: LIMITS.products + 1 }, (_, i) => ref(i))]) assert.throws(() => validate(input, options));
  assert.equal(validate(Array.from({ length: 10 }, (_, i) => ref(i)), options).length, 10);
  assert.throws(() => validate([ref()], { ...live, confirm: 'wrong' }));
  for (const change of [{ polls: 9 }, { polls: -1 }, { polls: 1.5 }, { intervalMs: 9999 },
    { intervalMs: 30001 }, { durationMs: 180001 }, { durationMs: NaN }]) assert.throws(() => validate([ref()], { ...options, ...change }));
});
test('Pricing smoke polling and duplicate pending requests are strictly bounded', async () => {
  const h = harness();
  assert.equal(await runSmoke([ref()], { ...live, duplicatePending: true }, h.deps), 'pending-or-stale-at-limit');
  assert.equal(h.counts().calls, 10); assert.equal(h.sleeps.length, 8); assert.equal(h.counts().disposed, 1);
});
test('Pricing smoke stops polling at total deadline, including RPC elapsed time', async () => {
  const h = harness();
  h.set(async () => { h.advance(4000); return { ok: true, data: [{ ...ref(), providers: { yahoo: {
    provider: 'yahoo', status: 'pending', stale: false, lowest_price: null, offer_count: null, fetched_at: null, expires_at: null,
  } } }] }; });
  assert.equal(await runSmoke([ref()], { ...live, durationMs: 15000 }, h.deps), 'time-limit');
  assert.equal(h.counts().calls, 2); assert.equal(h.sleeps.length, 1);
});
test('Pricing smoke fresh/unsupported/empty returns do not poll', async () => {
  for (const status of ['complete', 'unsupported', 'empty']) {
    const h = harness(status);
    assert.equal(await runSmoke([ref()], live, h.deps), 'responses-terminal-observation-required');
    assert.equal(h.counts().calls, 1);
  }
});
test('Pricing smoke records only summary fields needed for saved-result comparison', async () => {
  const h = harness('complete'); await runSmoke([ref()], live, h.deps);
  const event = h.events[1] as { states: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(event.states[0]).sort(),
    ['expires_at', 'fetched_at', 'lowest_price', 'offer_count', 'stale', 'status']);
  assert(!JSON.stringify(event).includes(ref().upstream_key));
});
test('Pricing smoke stale responses continue only up to configured bound', async () => {
  const h = harness('complete', true);
  await runSmoke([ref()], { ...live, polls: 1 }, h.deps); assert.equal(h.counts().calls, 2);
});
test('Pricing smoke stops on first error including 429 and never logs secrets', async () => {
  for (const error of [new Error('429 appid=PRIVATE_SECRET'), new Error('configuration PRIVATE_SECRET')]) {
    const h = harness(); h.set(async () => { throw error; });
    await assert.rejects(runSmoke([ref()], live, h.deps));
    assert.deepEqual(h.counts(), { connects: 1, calls: 1, disposed: 1 });
    assert(!JSON.stringify(h.events).includes('PRIVATE_SECRET'));
  }
});
test('Pricing smoke stops on RPC failure or invalid response without dumping bodies', async () => {
  for (const response of [{ ok: false, error: { code: 'PRIVATE_SECRET' } }, { ok: true, data: [] },
    { ok: true, data: [{ ...ref(2), providers: {} }] }]) {
    const h = harness(); h.set(async () => response as never);
    await assert.rejects(runSmoke([ref()], live, h.deps));
    assert.equal(h.counts().calls, 1); assert(!JSON.stringify(h.events).includes('PRIVATE_SECRET'));
  }
});
test('Pricing smoke never starts connector after rejected input', async () => {
  const h = harness(); await assert.rejects(runSmoke([{ secret: 'PRIVATE_SECRET' }], live, h.deps));
  assert.equal(h.counts().connects, 0); assert.equal(h.events.length, 0);
});
test('Pricing smoke bounds a hung RPC and disposes without retrying', async () => {
  const h = harness(); h.set(() => new Promise(() => {}));
  await assert.rejects(runSmoke([ref()], { ...live, durationMs: 1000 }, h.deps), /TIME_LIMIT/);
  assert.deepEqual(h.counts(), { connects: 1, calls: 1, disposed: 1 });
});
test('diagnostic SQL runs with SQLite query_only enabled, after real migrations', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync('migrations/0001_pricing.sql', 'utf8') + readFileSync('migrations/0002_demand_warmup.sql', 'utf8'));
  db.exec('CREATE TABLE d1_migrations(id INTEGER,name TEXT,applied_at TEXT); PRAGMA query_only=ON;');
  for (const file of ['01-schema', '02-plan', '03-state']) db.exec(readFileSync(`scripts/diagnostics/${file}.sql`, 'utf8'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM product_price_summary').get()!.n, 0);
});
test('offline Node service-binding RPC transport supports the smoke runner', { timeout: 30000 }, async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, log: new Log(LogLevel.ERROR), workers: [
    { name: 'caller', modules: true, script: 'export default {};', serviceBindings: { PRICING: 'mock-pricing' } },
    { name: 'mock-pricing', modules: true, compatibilityDate: '2026-09-26',
      script: `import { WorkerEntrypoint } from 'cloudflare:workers';
        export default class extends WorkerEntrypoint {
          getPriceSummaries(refs) { return { ok:true, data:refs.map(ref=>({...ref,providers:{yahoo:{provider:'yahoo',
            status:'unsupported',stale:false,lowest_price:null,offer_count:0,fetched_at:null,expires_at:null}}})) }; }
        }`, outboundService: async () => { throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); } },
  ] }));
  t.after(() => mf.dispose());
  const bindings = await mf.getBindings<{ PRICING: PricingRpc }>('caller');
  const h = harness();
  const outcome = await runSmoke([ref()], live, { ...h.deps,
    connect: async () => ({ rpc: bindings.PRICING, dispose: async () => {} }) });
  assert.equal(outcome, 'responses-terminal-observation-required');
});
