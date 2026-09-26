import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ref, identifier, codes, body } from './helpers';
import { Enqueuer } from '../src/queue/enqueue';
import { Consumer } from '../src/queue/consumer';
import { schedule } from '../src/scheduler/cron';
import { YahooBudget, reserveQueue } from '../src/storage/budget';
import { CandidateCache, YahooProvider } from '../src/providers/yahoo/service';
import { DAY } from '../src/config';
import { RefreshError } from '../src/providers/errors';
import type { Lane, RefreshMessage } from '../src/pricing/model';

test('interactive bypasses 100 background messages, promotes queued ref and fences its old delivery', async t => {
  const h = harness(t), interactive: RefreshMessage[] = [];
  const q = { sendBatch: async (messages: { body: RefreshMessage }[]) => { interactive.push(...messages.map(m => m.body)); } } as unknown as Queue<RefreshMessage>;
  const enqueue = new Enqueuer(h.store, h.queue, h.cfg, h.log, h.now, q);
  const refs = Array.from({ length: 100 }, (_, i) => ref(i + 1));
  await h.store.seed(refs, h.now()); await enqueue.enqueue(refs, 'cold_warmup');
  const old = h.messages.find(m => m.upstream_key === ref(100).upstream_key)!;
  await enqueue.enqueue([ref(100)], 'user_request');
  assert.equal(h.messages.length, 100); assert.equal(interactive.length, 1);
  let calls = 0;
  const consumer = new Consumer(h.store, { identifiers: async () => { calls++; return []; } },
    { lookup: async () => ({ status: 'unsupported', lowest_price: null, offer_count: 0, fetched_at: null, expires_at: h.now() + DAY }) }, h.log, h.now);
  await consumer.process(interactive[0]); await consumer.process(old);
  assert.equal(calls, 1); assert.equal(h.row(ref(100)).status, 'unsupported');
  assert.equal(h.row(ref(1)).status, 'pending');
  await enqueue.enqueue([ref(100)], 'user_request'); assert.equal(interactive.length, 1);
});

test('running background refresh is not duplicated by polling', async t => {
  const h = harness(t); await h.store.seed([ref()], h.now()); await h.enqueuer.enqueue([ref()], 'default_warmup');
  await h.store.acquire(h.messages[0], h.now(), crypto.randomUUID());
  for (let i = 0; i < 5; i++) { await h.read([ref()]); await h.flush(); }
  assert.equal(h.messages.length, 1);
});

test('default targets precede cold; every background tier gets a reserved slot under default backlog', async t => {
  const h = harness(t);
  for (let i = 0; i < 100; i++) h.put(ref(i), 'pending', { is_default: 1, last_requested_at: null, next_refresh_at: h.now() });
  for (let priority = 0; priority < 4; priority++) h.put(ref(100 + priority), 'pending', { priority, last_requested_at: null, next_refresh_at: h.now() });
  for (let tick = 0; tick < 4; tick++) {
    await schedule(h.store, h.enqueuer, h.cfg, h.log, h.now()); h.advance(900000);
  }
  assert.equal(h.messages.length, 32);
  assert(h.messages.slice(0, 8).some(m => m.reason === 'default_warmup'));
  for (let i = 100; i < 104; i++) assert(h.messages.some(m => m.upstream_key === ref(i).upstream_key));
});

test('shared minute/pacing budget reserves 24 interactive and 6 background external admissions', async t => {
  const h = harness(t), waits: number[] = [];
  const budget = (lane: Lane) => new YahooBudget(h.db, h.cfg, h.log, h.now, async ms => { waits.push(ms); h.advance(ms); }, lane);
  for (let i = 0; i < 24; i++) await budget('interactive').admit();
  for (let i = 0; i < 6; i++) await budget('background').admit();
  const state = h.sqlite.prepare("SELECT * FROM work_budget WHERE name='yahoo'").get()!;
  assert.equal(state.minute_count, 30); assert.equal(state.background_minute_count, 6);
  assert.equal(h.now() % 60000, 29000);
  await budget('interactive').admit();
  assert.equal(waits.at(-1), 31000);
  assert.equal(h.sqlite.prepare("SELECT day_count FROM work_budget WHERE name='yahoo'").get()!.day_count, 31);
});

test('background daily ceilings preserve interactive headroom, interactive ceilings preserve background capacity', async t => {
  const h = harness(t), day = Math.floor(h.now() / DAY);
  h.sqlite.prepare("UPDATE work_budget SET day=?,day_count=900,background_day_count=900 WHERE name='yahoo'").run(day);
  const make = (lane: Lane) => new YahooBudget(h.db, h.cfg, h.log, h.now, async ms => h.advance(ms), lane);
  await assert.rejects(make('background').admit(), RefreshError);
  await make('interactive').admit();
  h.sqlite.prepare("UPDATE work_budget SET day_count=1200,background_day_count=0 WHERE name='yahoo'").run();
  await assert.rejects(make('interactive').admit(), RefreshError);
  await make('background').admit();
  assert.equal(await reserveQueue(h.db, 800, h.now(), 1000, 'interactive'), true);
  assert.equal(await reserveQueue(h.db, 1, h.now(), 1000, 'interactive'), false);
  assert.equal(await reserveQueue(h.db, 200, h.now(), 1000, 'background'), true);
  assert.equal(await reserveQueue(h.db, 1, h.now(), 1000, 'background'), false);
});

for (const lane of ['interactive', 'background'] as const) {
  test(`${lane} fallback accounts every external candidate and cannot bypass shared budget`, async t => {
    const h = harness(t); let calls = 0;
    const provider = new YahooProvider(h.cfg, 'mock', new YahooBudget(h.db, h.cfg, h.log, h.now, async ms => h.advance(ms), lane),
      h.log, undefined, new CandidateCache(), h.now, async () => { calls++; return Response.json(body([])); });
    assert.equal((await provider.lookup(codes.slice(0, 3).map(c => identifier(c)))).status, 'empty');
    assert.equal(calls, 3);
    assert.equal(h.sqlite.prepare("SELECT day_count FROM work_budget WHERE name='yahoo'").get()!.day_count, 3);
    await provider.lookup(codes.slice(0, 3).map(c => identifier(c))); assert.equal(calls, 3);
  });
}
