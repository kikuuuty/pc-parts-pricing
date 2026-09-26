import test from 'node:test';
import assert from 'node:assert/strict';
import { Consumer } from '../src/queue/consumer';
import { CandidateCache, YahooProvider } from '../src/providers/yahoo/service';
import { RefreshError } from '../src/providers/errors';
import { harness, ref, body, identifier } from './helpers';
import { POLICY } from '../src/config';

test('consumer checks newest summary and skips fresh without catalog or Provider', async t => {
  const h = harness(t); await h.service.requestRefresh([ref()]);
  const queued = h.row(); h.put(ref(), 'complete', { queue_token: queued.queue_token, queued_until: queued.queued_until });
  const consumer = new Consumer(h.store, { identifiers: async () => { throw Error('must not run'); } },
    { lookup: async () => { throw Error('must not run'); } }, h.log, h.now);
  await consumer.process(h.messages[0]);
  assert.equal(h.row().status, 'complete'); assert.equal(h.row().queue_token, null);
});

for (const kind of ['complete', 'empty', 'unsupported', 'missing'] as const) {
  test(`consumer persists ${kind} with next_refresh_at and clears lease`, async t => {
    const h = harness(t); let fetches = 0;
    h.put(ref(), 'complete', { expires_at: h.now() - 1, next_refresh_at: h.now() - 1 });
    await h.service.requestRefresh([ref()]);
    const provider = new YahooProvider(h.cfg, 'test', { admit: async () => {}, cooldown: async () => {} }, h.log,
      undefined, new CandidateCache(), h.now, async () => { fetches++; return Response.json(body(kind === 'empty' ? [] : undefined)); });
    const consumer = new Consumer(h.store, { identifiers: async () => kind === 'missing' ? null : kind === 'unsupported' ? [] : [identifier()] }, provider, h.log, h.now);
    await consumer.process(h.messages[0]);
    const row = h.row();
    assert.equal(row.status, kind); assert.equal(row.queue_token, null); assert.equal(row.run_token, null);
    assert(row.next_refresh_at > h.now()); assert.equal(row.failure_count, 0);
    assert.equal(fetches, kind === 'complete' || kind === 'empty' ? 1 : 0);
    assert.equal(row.lowest_price, kind === 'complete' ? 57800 : null);
    await consumer.process(h.messages[0]); // at-least-once redelivery
    assert.equal(fetches, kind === 'complete' || kind === 'empty' ? 1 : 0);
  });
}

const failures: [string, typeof fetch][] = [
  ['timeout', async () => new Promise(() => {})],
  ['upstream_429', async () => new Response('', { status: 429, headers: { 'Retry-After': '3600' } })],
  ['upstream_5xx', async () => new Response('', { status: 500 })],
  ['invalid_json', async () => new Response('private')],
  ['malformed_response', async () => Response.json({})],
];
for (const [reason, fetcher] of failures) {
  for (const stale of [false, true]) {
    test(`Queue ${reason}: ${stale ? 'stale retained' : 'pending retained'}, backoff not empty`, async t => {
      const h = harness(t);
      if (stale) h.put(ref(), 'complete', { expires_at: h.now() - 1 });
      await h.service.requestRefresh([ref()]);
      const provider = new YahooProvider(h.cfg, 'test', { admit: async () => {}, cooldown: async () => {} }, h.log,
        undefined, new CandidateCache(), h.now, fetcher, 10);
      const consumer = new Consumer(h.store, { identifiers: async () => [identifier()] }, provider, h.log, h.now);
      await consumer.process(h.messages[0]);
      const row = h.row();
      assert.equal(row.status, stale ? 'complete' : 'pending'); assert.equal(row.last_error, reason);
      assert.equal(row.failure_count, 1); assert.equal(row.queue_token, null);
      assert(row.next_refresh_at >= h.now() + POLICY.failureBase);
      if (reason === 'upstream_429') assert(row.retry_after >= h.now() + 3600000);
      await h.service.requestRefresh([ref()]); assert.equal(h.messages.length, 1);
    });
  }
}

test('D1 commit failure is retried; successful Provider result reused without another lookup', async t => {
  const h = harness(t); let fetches = 0;
  await h.service.requestRefresh([ref()]);
  const provider = new YahooProvider(h.cfg, 'test', { admit: async () => {}, cooldown: async () => {} }, h.log,
    undefined, new CandidateCache(), h.now, async () => { fetches++; return Response.json(body()); });
  const consumer = new Consumer(h.store, { identifiers: async () => [identifier()] }, provider, h.log, h.now);
  h.fail(/SET status=/);
  await assert.rejects(consumer.process(h.messages[0]), (e: RefreshError) => e.reason === 'storage');
  assert.equal(h.row().status, 'pending'); assert(h.row().run_token);
  h.advance(360000); await consumer.process(h.messages[0]);
  assert.equal(h.row().status, 'complete'); assert.equal(fetches, 1);
});

test('old queue and execution tokens cannot overwrite a newer result', async t => {
  const h = harness(t);
  await h.service.requestRefresh([ref()]); const old = h.messages[0];
  const owner = crypto.randomUUID(); await h.store.acquire(old, h.now(), owner);
  h.advance(POLICY.queueLease + 1); await h.service.requestRefresh([ref()]);
  const current = h.messages[1]; assert.notEqual(current.token, old.token);
  assert.equal(await h.store.finish(old, owner, { status: 'complete', lowest_price: 1, offer_count: 1,
    fetched_at: h.now(), expires_at: h.now() + h.cfg.ttl }, h.now() + h.cfg.ttl, 0, h.now()), false);
  let calls = 0;
  const consumer = new Consumer(h.store, { identifiers: async () => { calls++; return []; } },
    { lookup: async () => ({ status: 'unsupported', lowest_price: null, offer_count: 0, fetched_at: null,
      expires_at: h.now() + POLICY.unsupportedInterval }) }, h.log, h.now);
  await consumer.process(old); assert.equal(calls, 0);
  await consumer.process(current); assert.equal(calls, 1);
});

test('overlapping delivery retries its run lease and malformed messages are acknowledged safely', async t => {
  const h = harness(t); await h.service.requestRefresh([ref()]);
  const consumer = new Consumer(h.store, { identifiers: async () => { throw Error('unexpected'); } },
    { lookup: async () => { throw Error('unexpected'); } }, h.log, h.now);
  await h.store.acquire(h.messages[0], h.now(), crypto.randomUUID());
  await assert.rejects(consumer.process(h.messages[0]), RefreshError);
  for (const value of [null, {}, { ...h.messages[0], provider: 'other' }, { ...h.messages[0], secret: 'private' }]) await consumer.process(value);
  assert(h.logs.some(e => e.queue_result === 'invalid'));
});

test('catalog errors keep price data and do not call Provider', async t => {
  const h = harness(t); await h.service.requestRefresh([ref()]);
  const consumer = new Consumer(h.store, { identifiers: async () => { throw new RefreshError('catalog_unavailable'); } },
    { lookup: async () => { throw Error('unexpected'); } }, h.log, h.now);
  await consumer.process(h.messages[0]);
  assert.equal(h.row().status, 'pending'); assert.equal(h.row().last_error, 'catalog_unavailable');
});
