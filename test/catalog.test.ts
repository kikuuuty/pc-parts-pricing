import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogClient } from '../src/catalog/client';
import { RefreshError } from '../src/providers/errors';
import { identifier, ref } from './helpers';

const resolved = (changes = {}) => ({ products: [{ ...ref(), id: 999, status: 'active', active: true, ...changes }] });
const detail = (changes = {}) => ({ ...ref(), id: 999, identifiers: [identifier()], ...changes });
function client(responses: unknown[], status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const binding = { fetch: async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json(responses.shift(), { status });
  } } as unknown as Fetcher;
  return { api: new CatalogClient(binding), calls };
}

test('catalog resolves durable reference then loads canonical identifiers via Service Binding', async () => {
  const h = client([resolved(), detail()]);
  assert.deepEqual(await h.api.identifiers(ref()), [identifier()]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, 'https://catalog.internal/v1/products/resolve');
  assert.deepEqual(JSON.parse(String(h.calls[0].init?.body)), { products: [ref()] });
  assert.equal(h.calls[1].url, 'https://catalog.internal/v1/products/999');
  assert(!h.calls.some(c => c.url.includes('offers')));
});

test('catalog missing/inactive never trigger detail or price search', async () => {
  for (const status of ['missing', 'inactive']) {
    const h = client([resolved({ status, active: false })]);
    assert.equal(await h.api.identifiers(ref()), null); assert.equal(h.calls.length, 1);
  }
});

test('catalog validates identity again after rebuild and rejects malformed identifiers', async () => {
  for (const payload of [detail({ upstream_key: 'CPU/wrong' }), detail({ source: 'other' }),
    detail({ id: 1000 }), detail({ identifiers: null }), detail({ identifiers: [{}] }),
    detail({ identifiers: [{ ...identifier(), origins: [null] }] })]) {
    const h = client([resolved(), payload]);
    await assert.rejects(h.api.identifiers(ref()), (e: RefreshError) => e.reason === 'catalog_invalid');
  }
  for (const payload of [{}, resolved({ status: 'other' }), resolved({ id: '999' }), resolved({ upstream_key: 'CPU/wrong' })]) {
    await assert.rejects(client([payload]).api.identifiers(ref()), RefreshError);
  }
});

test('catalog 429, timeout and invalid JSON are errors rather than unsupported', async () => {
  await assert.rejects(client([{}], 429).api.identifiers(ref()), (e: RefreshError) => e.reason === 'catalog_unavailable');
  const stalled = new CatalogClient({ fetch: async () => new Promise(() => {}) } as unknown as Fetcher, 10);
  await assert.rejects(stalled.identifiers(ref()), (e: RefreshError) => e.reason === 'catalog_unavailable');
  const broken = new CatalogClient({ fetch: async () => new Response('private upstream body') } as unknown as Fetcher);
  await assert.rejects(broken.identifiers(ref()), (e: RefreshError) => e.reason === 'catalog_unavailable' && !e.message.includes('private'));
});
