import test from 'node:test';
import assert from 'node:assert/strict';
import { config, DAY, HOUR, POLICY } from '../src/config';
import { summary, refreshTier } from '../src/pricing/freshness';
import { harness, ref } from './helpers';
import { DUE_SQL, LOOKUP_SQL } from '../src/storage/summaries';
import { schedule } from '../src/scheduler/cron';
import { Enqueuer } from '../src/queue/enqueue';

test('20 summaries: indexed one-query lookup preserves order, duplicates and every status', async t => {
  const h = harness(t);
  h.put(ref(1), 'complete'); h.put(ref(2), 'empty'); h.put(ref(3), 'unsupported'); h.put(ref(4), 'pending');
  h.put(ref(5), 'complete', { expires_at: h.now() - 1 }); h.put(ref(6), 'missing');
  const input = [ref(5), ref(2), ref(1), ref(3), ref(4), ref(1), ref(6), ...Array.from({ length: 13 }, (_, i) => ref(i + 10))];
  // Count the indexed read separately from background touch/enqueue statements.
  const tasks: Promise<unknown>[] = [];
  const result = await h.service.getPriceSummaries(input, task => tasks.push(task));
  assert.deepEqual(result.map(({ source, upstream_key }) => ({ source, upstream_key })), input);
  assert.deepEqual(result.slice(0, 7).map(p => p.providers.yahoo.status), ['complete', 'empty', 'complete', 'unsupported', 'pending', 'complete', 'missing']);
  assert.equal(result[0].providers.yahoo.stale, true);
  assert.equal(result[0].providers.yahoo.lowest_price, 57800);
  assert.equal(result[1].providers.yahoo.offer_count, 0);
  assert.equal(result[4].providers.yahoo.offer_count, null);
  assert.equal(result[7].providers.yahoo.status, 'pending');
  assert.equal(h.statements.filter(sql => sql === LOOKUP_SQL).length, 1);
  await Promise.all(tasks);
  assert.equal(h.messages.length, 15); // stale + pending + 13 uncached; no duplicate enqueue
});

test('warm reads do not write, enqueue or extend fetched_at', async t => {
  const h = harness(t), row = h.put();
  const results = await Promise.all(Array.from({ length: 5 }, () => h.read([ref()])));
  await h.flush();
  assert.equal(h.statements.length, 5);
  assert(h.statements.every(sql => sql === LOOKUP_SQL));
  assert.equal(h.messages.length, 0);
  assert.equal(results[4][0].providers.yahoo.fetched_at, new Date(row.fetched_at!).toISOString());
});

test('stale allowance is bounded; expired values become pending, never empty', t => {
  const h = harness(t), row = h.put(ref(), 'complete', { expires_at: h.now() - h.cfg.maxStale });
  assert.equal(summary(row, h.now(), h.cfg).status, 'pending');
  assert.equal(summary(row, h.now(), h.cfg).lowest_price, null);
  assert.equal(summary(row, h.now() - 1, h.cfg).status, 'complete');
  assert.equal(summary(row, row.expires_at!, { ...h.cfg, maxStale: 0 }).status, 'pending');
});

for (const input of [null, {}, [], Array(21).fill(ref()), [1], [{ ...ref(), id: 1 }],
  [{ source: 'UPPER', upstream_key: 'CPU/a' }], [{ source: 'buildcores', upstream_key: 'CPU/..' }],
  [{ source: 'buildcores', upstream_key: 'CPU/a/b' }], [{ source: 'buildcores', upstream_key: 'CPU/' + 'x'.repeat(201) }]]) {
  test(`invalid summary input is rejected before SQL: ${JSON.stringify(input).slice(0, 55)}`, async t => {
    const h = harness(t);
    await assert.rejects(h.read(input), /INVALID_REQUEST/);
    assert.equal(h.statements.length, 0);
  });
}

test('concurrent duplicate enqueue coalesces durably, including across Enqueuer instances', async t => {
  const h = harness(t);
  await h.store.touch([ref()], h.now());
  await Promise.all(Array.from({ length: 12 }, () =>
    new Enqueuer(h.store, h.queue, h.cfg, h.log, h.now).enqueue([ref(), ref()], 'user_request')));
  assert.equal(h.messages.length, 1);
  assert.equal(h.sqlite.prepare("SELECT day_count FROM work_budget WHERE name='queue'").get()!.day_count, 1);
  assert.equal(h.row().access_count, 1);
});

test('fresh/unsupported are not enqueued; expired unsupported is only rechecked by Cron', async t => {
  const h = harness(t);
  h.put(ref(1)); h.put(ref(2), 'unsupported', { expires_at: h.now() - 1, next_refresh_at: h.now() - 1, priority: 3 });
  await h.read([ref(1), ref(2)]); await h.flush();
  await h.service.requestRefresh([ref(1), ref(2)]);
  assert.equal(h.messages.length, 0);
  await schedule(h.store, h.enqueuer, h.cfg, h.log, h.now());
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].reason, 'scheduled_refresh');
});

test('access tracking is hourly and capped; refresh tiers age from 6h to 14d', async t => {
  const h = harness(t);
  await h.store.touch([ref()], h.now());
  for (let i = 0; i < 2; i++) { h.advance(HOUR); await h.store.touch([ref()], h.now()); }
  assert.equal(h.row().access_count, 3);
  assert.equal(refreshTier(h.row(), h.now()).interval, 6 * HOUR);
  assert.equal(refreshTier(h.row(), h.now() + 2 * DAY).interval, DAY);
  assert.equal(refreshTier(h.row(), h.now() + 8 * DAY).interval, 3 * DAY);
  assert.equal(refreshTier(h.row(), h.now() + 31 * DAY).interval, 14 * DAY);
  h.advance(DAY); await h.store.touch([ref()], h.now());
  assert.equal(h.row().access_count, 1);
});

test('Cron has a strict batch limit, hot priority and low-priority warmup cap', async t => {
  const h = harness(t);
  const seed = Array.from({ length: 20 }, (_, i) => ref(i + 10));
  assert.equal((await h.service.seedWarmup(seed)).registered, 20);
  assert.equal((await h.service.seedWarmup(seed)).registered, 0);
  h.put(ref(), 'complete', { expires_at: h.now() - 1, next_refresh_at: h.now() - 1, priority: 0 });
  await schedule(h.store, h.enqueuer, h.cfg, h.log, h.now());
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[0].upstream_key, ref().upstream_key);
  assert.equal(h.messages[1].reason, 'cold_warmup');
  assert.equal(h.row(seed[1]).last_requested_at, null);
});

test('daily enqueue cap and failed sends release claims into backoff', async t => {
  const h = harness(t); h.cfg.queueDaily = 1;
  await h.service.requestRefresh([ref()]);
  await h.service.requestRefresh([ref(2)]);
  assert.equal(h.messages.length, 1);
  assert.equal(h.row(ref(2)).queue_token, null);
  assert(h.row(ref(2)).retry_after > h.now());
  h.advance(DAY); h.sendFails();
  await h.service.requestRefresh([ref(3)]);
  assert.equal(h.row(ref(3)).queue_token, null);
  assert.equal(h.row(ref(3)).retry_after, h.now() + 900000);
});

test('abandoned enqueue leases are recovered by indexed Cron without old token reuse', async t => {
  const h = harness(t);
  await h.service.requestRefresh([ref()]); const first = h.messages[0];
  h.advance(POLICY.queueLease + 1);
  await schedule(h.store, h.enqueuer, h.cfg, h.log, h.now());
  assert.equal(h.messages.length, 2);
  assert.notEqual(h.messages[1].token, first.token);
});

test('D1 read errors propagate, async enqueue errors preserve cached responses', async t => {
  const h = harness(t);
  h.fail(/SELECT s\.\*/); await assert.rejects(h.read([ref()]));
  h.fail(/INSERT INTO product_price_summary/);
  assert.equal((await h.read([ref()]))[0].providers.yahoo.status, 'pending');
  await h.flush();
  assert(h.logs.some(e => e.event === 'background' && e.queue_result === 'error'));
});

test('SQLite plans use primary-key probes and bounded due index ranges', t => {
  const h = harness(t);
  const plan = h.sqlite.prepare('EXPLAIN QUERY PLAN ' + LOOKUP_SQL).all(JSON.stringify([ref()]));
  assert(plan.some(r => /SEARCH s USING PRIMARY KEY/.test(String(r.detail))));
  const due = h.sqlite.prepare('EXPLAIN QUERY PLAN ' + DUE_SQL).all(0, h.now(), 4);
  assert(due.some(r => /SEARCH.*price_refresh_due/.test(String(r.detail))));
  assert(!due.some(r => /SCAN|TEMP B-TREE/.test(String(r.detail))));
});

test('enqueue claim is also bounded by requested primary keys, not provider-wide rows', async t => {
  const h = harness(t);
  await h.store.seed([ref()], h.now());
  const token = crypto.randomUUID();
  await h.store.claim([ref()], h.now(), token, false);
  const sql = h.statements.find(sql => sql.startsWith('UPDATE product_price_summary'))!;
  const plan = h.sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all(token, h.now() + POLICY.queueLease, h.now(), JSON.stringify([ref()]));
  assert(plan.some(r => /SEARCH product_price_summary USING PRIMARY KEY/.test(String(r.detail))), JSON.stringify(plan));
  assert(!plan.some(r => /SCAN product_price_summary/.test(String(r.detail))));
});

test('configuration fails closed on invalid values and cannot exceed Free enqueue guard', () => {
  for (const value of ['-1', '1.5', 'foo', '1001']) assert.throws(() => config({ QUEUE_DAILY_LIMIT: value }));
  assert.throws(() => config({ YAHOO_PACING_MS: '999' }));
  assert.equal(config({ YAHOO_SUMMARY_TTL_SECONDS: '3600' }).ttl, HOUR);
});
