import test from 'node:test';
import assert from 'node:assert/strict';
import { batchSummaries, batchWrite, type PricingBatchRpc } from '../src/pricing/batch';
import { RPC_CHUNK_SIZE, SQL_CHUNK_SIZE } from '../src/config';
import { LOOKUP_SQL } from '../src/storage/summaries';
import { harness, ref } from './helpers';

for (const size of [20, 49, 50, 51, 100, 101, 250, 251, 601]) {
  test(`internal RPC/SQL batching: ${size} refs with cross-boundary duplicates and input order`, async t => {
    const h = harness(t), refs = Array.from({ length: size }, (_, i) => ref(i + 1));
    refs.forEach(r => h.put(r));
    const calls: number[] = [];
    const rpc = { summaries: async products => {
      calls.push(products.length);
      const start = h.statements.length;
      const result = await h.read(products); await h.flush();
      assert(h.statements.length - start < 50);
      return result;
    } } as PricingBatchRpc;
    const input = [refs.at(-1)!, ...refs, refs[0], refs.at(-1)!];
    const result = await batchSummaries(input, rpc);
    assert.deepEqual(result.map(({ source, upstream_key }) => ({ source, upstream_key })), input);
    assert(result.every(p => p.providers.yahoo.status === 'complete'));
    assert(calls.every(n => n <= RPC_CHUNK_SIZE));
    assert.equal(calls.reduce((a, b) => a + b), size);
    assert.equal(h.statements.filter(sql => sql === LOOKUP_SQL).length, Math.ceil(size / SQL_CHUNK_SIZE));
    assert.equal(h.messages.length, 0);
  });
}

test('invalid ref beyond a chunk boundary rejects the entire request before side effects', async t => {
  const h = harness(t);
  const rpc = { seed: (products: unknown) => h.service.seedWarmup(products) } as PricingBatchRpc;
  await assert.rejects(batchWrite([...Array.from({ length: 601 }, (_, i) => ref(i)), { ...ref(), id: 42 }], rpc, 'seed'), /INVALID_REQUEST/);
  assert.equal(h.statements.length, 0);
});

test('601 cold refs register without enqueue; 601 demanded refs use bounded sendBatch and dedupe polling', async t => {
  const h = harness(t), refs = Array.from({ length: 601 }, (_, i) => ref(i + 1));
  const rpc = {
    seed: (products: unknown) => h.service.seedWarmup(products),
    refresh: async (products: unknown) => {
      const start = h.statements.length;
      const result = await h.service.requestRefresh(products);
      assert(h.statements.length - start < 50);
      return result;
    },
  } as PricingBatchRpc;
  assert.equal(await batchWrite([...refs, refs[0]], rpc, 'seed'), 601);
  assert.equal(await batchWrite(refs, rpc, 'seed'), 0);
  assert.equal(h.messages.length, 0);
  assert.equal(await batchWrite([...refs, refs[0]], rpc, 'refresh'), 601);
  assert.equal(await batchWrite(refs, rpc, 'refresh'), 0);
  assert.equal(h.messages.length, 601);
  assert.equal(new Set(h.messages.map(m => m.upstream_key)).size, 601);
});

test('exhausted enqueue budget and send failures release a whole bounded chunk, not N SQL calls', async t => {
  const h = harness(t); h.cfg.queueDaily = 1;
  const refs = Array.from({ length: 250 }, (_, i) => ref(i));
  await h.service.requestRefresh(refs);
  assert(h.statements.length < 50);
  assert(refs.every(r => h.row(r).queue_token === null));
});
