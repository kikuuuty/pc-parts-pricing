import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, ref, body, identifier } from './helpers';
import { YahooBudget } from '../src/storage/budget';
import { CandidateCache, YahooProvider } from '../src/providers/yahoo/service';
import { RefreshError } from '../src/providers/errors';
import { schedule } from '../src/scheduler/cron';
import { DAY } from '../src/config';
import type { RefreshMessage } from '../src/pricing/model';

test('repeated 500/503 share cooldown across lanes; bounded probes resume automatically', async t => {
  const h = harness(t); let calls = 0;
  const state = () => h.sqlite.prepare("SELECT * FROM work_budget WHERE name='yahoo'").get()!;
  const lookup = (status: number, lane: 'background' | 'interactive' = 'interactive') =>
    new YahooProvider(h.cfg, 'test', new YahooBudget(h.db, h.cfg, h.log, h.now,
      async ms => h.advance(ms), lane), h.log, undefined, new CandidateCache(), h.now,
    async () => { calls++; return status === 200 ? Response.json(body()) : new Response('', { status }); })
      .lookup([identifier()]);
  await assert.rejects(lookup(500), RefreshError);
  assert.equal(state().failure_streak, 1); assert.equal(state().recovery_remaining, 0);
  await assert.rejects(lookup(503, 'background'), RefreshError);
  assert.equal(state().next_allowed_at, h.now() + 60000);
  await assert.rejects(lookup(200), (e: RefreshError) => e.reason === 'rate_limit');
  assert.equal(calls, 2);
  h.advance(60000);
  await assert.rejects(lookup(500), RefreshError);
  assert.equal(state().next_allowed_at, h.now() + 120000);
  h.advance(120000);
  for (let i = 0; i < 3; i++) assert.equal((await lookup(200)).status, 'complete');
  assert.equal(state().failure_streak, 0); assert.equal(state().recovery_remaining, 0);
  assert.equal(calls, 6);
  assert.equal(state().day_count, 6);
});

test('success of an older in-flight request cannot close a newer circuit', async t => {
  const h = harness(t);
  const old = new YahooBudget(h.db, h.cfg, h.log, h.now, async ms => h.advance(ms));
  await old.admit(); h.advance(1);
  const other = new YahooBudget(h.db, h.cfg, h.log, h.now);
  await other.failed(); await other.failed(); await old.succeeded();
  const row = h.sqlite.prepare("SELECT * FROM work_budget WHERE name='yahoo'").get()!;
  assert.equal(row.failure_streak, 2); assert.equal(row.recovery_remaining, 3);
});

test('5xx cooldown is capped and a single transient 500 resets after a real success', async t => {
  const h = harness(t), budget = new YahooBudget(h.db, h.cfg, h.log, h.now, async ms => h.advance(ms));
  await budget.admit(); await budget.failed();
  h.advance(1000); await budget.admit(); await budget.succeeded();
  assert.equal(h.sqlite.prepare("SELECT failure_streak FROM work_budget WHERE name='yahoo'").get()!.failure_streak, 0);
  for (let i = 0; i < 20; i++) await budget.failed();
  const state = h.sqlite.prepare("SELECT * FROM work_budget WHERE name='yahoo'").get()!;
  assert.equal(state.failure_streak, 16); assert.equal(state.next_allowed_at, h.now() + 1800000);
  h.advance(1800000);
  for (let i = 0; i < 3; i++) {
    const resumed = new YahooBudget(h.db, h.cfg, h.log, h.now, async ms => h.advance(ms));
    await resumed.admit(); await resumed.succeeded();
  }
  assert.equal(h.sqlite.prepare("SELECT recovery_remaining FROM work_budget WHERE name='yahoo'").get()!.recovery_remaining, 0);
});

test('429 recovery probes, cache hits and individual malformed responses do not consume/reset health incorrectly', async t => {
  const h = harness(t), budget = new YahooBudget(h.db, h.cfg, h.log, h.now, async ms => h.advance(ms));
  await budget.cooldown(60);
  await assert.rejects(budget.admit(), RefreshError);
  h.advance(60000); await budget.admit(); await budget.succeeded();
  const state = () => h.sqlite.prepare("SELECT * FROM work_budget WHERE name='yahoo'").get()!;
  assert.equal(state().recovery_remaining, 2);
  const provider = new YahooProvider(h.cfg, 'test', budget, h.log, undefined, new CandidateCache(), h.now,
    async () => Response.json(body()));
  await provider.lookup([identifier()]);
  const before = state(); await provider.lookup([identifier()]);
  assert.deepEqual(state(), before);
  const invalid = new YahooProvider(h.cfg, 'test', budget, h.log, undefined, new CandidateCache(), h.now,
    async () => Response.json({}));
  await assert.rejects(invalid.lookup([identifier()]), RefreshError);
  assert.equal(state().failure_streak, 0);
});

test('accepted first pending is durable before response and Cron recovers enqueue failure without polling', async t => {
  const h = harness(t); h.sendFails();
  const response = await h.read([ref()]);
  assert.equal(response[0].providers.yahoo.status, 'pending');
  assert.equal(h.row().queue_lane, 'interactive');
  await h.flush();
  assert.equal(h.row().queue_token, null);
  h.advance(900001);
  // Replace only the queue transport; the registered work is recovered by Cron.
  const { Enqueuer } = await import('../src/queue/enqueue');
  let reason = '';
  const queue = { sendBatch: async (messages: { body: RefreshMessage }[]) => { reason = messages[0].body.reason; } } as unknown as Queue<RefreshMessage>;
  await schedule(h.store, new Enqueuer(h.store, queue, h.cfg, h.log, h.now), h.cfg, h.log, h.now());
  assert.equal(reason, 'user_request');
});

test('0003 preserves prices, leases and budgets in a populated database', async t => {
  const h = harness(t); h.put(ref());
  const before = h.row();
  // Recreate a pre-0003 budget table while retaining populated summary state.
  h.sqlite.exec(`ALTER TABLE work_budget DROP COLUMN failure_streak;
    ALTER TABLE work_budget DROP COLUMN failure_at; ALTER TABLE work_budget DROP COLUMN recovery_remaining;
    UPDATE work_budget SET day=100,day_count=15,next_allowed_at=123 WHERE name='yahoo';`);
  h.sqlite.exec(readFileSync('migrations/0003_provider_recovery.sql', 'utf8'));
  assert.deepEqual(h.row(), before);
  const state = h.sqlite.prepare("SELECT * FROM work_budget WHERE name='yahoo'").get()!;
  assert.equal(state.day_count, 15); assert.equal(state.next_allowed_at, 123);
  assert.equal(state.failure_streak, 0);
  h.advance(DAY);
  await new YahooBudget(h.db, h.cfg, h.log, h.now).admit();
  assert.equal(h.sqlite.prepare("SELECT day_count FROM work_budget WHERE name='yahoo'").get()!.day_count, 1);
});
