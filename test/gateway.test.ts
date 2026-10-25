import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, MAX_BODY_BYTES, ROUTE, type GatewayEvent } from '../src/gateway/http';
import { LIMITERS, type GatewayEnv } from '../src/gateway/protection';
import type { ProductRef } from '../src/pricing/model';
import { INITIAL_CONFIG, readGatewayConfig } from '../scripts/gateway-config';

const fixtures = JSON.parse(readFileSync('test/fixtures/gateway-http.json', 'utf8'));
const ref = (n = 1) => ({ source: 'buildcores', upstream_key: `CPU/test-${n}` });
const origin = 'http://localhost:5173';
function harness() {
  const calls: ProductRef[][] = [], checks: { name: string; key: string }[] = [], logs: GatewayEvent[] = [];
  const env: GatewayEnv = { ALLOWED_ORIGINS: JSON.stringify([origin]), SUMMARY_ENABLED: 'true',
    PRICING: { async getPriceSummaries(refs) {
      calls.push(refs);
      return { ok: true, data: refs.map(r => ({ ...r, providers: fixtures.pending.data[0].providers })) };
    } },
    ...Object.fromEntries(LIMITERS.map(name => [name, { async limit({ key }: { key: string }) {
      checks.push({ name, key }); return { success: true };
    } }])),
  } as GatewayEnv;
  const request = (body: unknown = { products: [ref()] }, options: RequestInit = {}, path = ROUTE) =>
    new Request(`http://gateway.test${path}`, { method: 'POST', body: JSON.stringify(body),
      ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  return { env, calls, checks, logs, request,
    send: (r = request()) => handle(r, env, e => logs.push(e)) };
}
async function error(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { ok: false, error: { code } });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('X-Request-ID')!, /^[a-f0-9-]{36}$/);
}

for (const n of [1, 20, 21, 100]) test(`Gateway accepts ${n} refs with one RPC, preserving order/duplicates`, async () => {
  const h = harness(), refs = Array.from({ length: n }, (_, i) => ref(i % 3));
  const response = await h.send(h.request({ products: refs }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(h.calls, [refs]);
  assert.deepEqual((await response.json() as any).data.map(({ providers, ...r }: any) => r), refs);
  assert.equal(h.checks.length, n > 20 ? 4 : 2);
});

for (const [name, fixture] of Object.entries<any>(fixtures).filter(([, v]) => v.ok === true))
  test(`Gateway transparently returns fixture: ${name}`, async () => {
    const h = harness(); h.env.PRICING.getPriceSummaries = async () => fixture;
    const response = await h.send(h.request(fixtures.request));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), fixture);
  });

test('Gateway accepts maximum-length legal 100 refs within 64KiB', async () => {
  const h = harness(), products = Array.from({ length: 100 }, () => ({ source: 'a'.repeat(64), upstream_key: `C/${'x'.repeat(198)}` }));
  assert(Buffer.byteLength(JSON.stringify({ products })) < MAX_BODY_BYTES);
  assert.equal((await h.send(h.request({ products }))).status, 200);
  assert.deepEqual(h.calls, [products]);
});

for (const products of [[], Array.from({ length: 101 }, (_, i) => ref(i)), Array(101).fill(ref()),
  [1], [{ product_id: 1 }], [{ ...ref(), price: 1 }], [{ ...ref(), source: ' Buildcores' }],
  [{ ...ref(), source: 'a'.repeat(65) }], [{ ...ref(), upstream_key: `C/${'x'.repeat(199)}` }],
  [{ ...ref(), upstream_key: 'CPU/..' }], [{ ...ref(), upstream_key: 'https://example.com' }],
  [{ source: 'buildcores', upstream_key: 123 }], [{ name: 'CPU', jan: '0012345678905' }]])
  test(`Gateway rejects invalid refs: ${JSON.stringify(products).slice(0, 100)}`, async () => {
    const h = harness(); await error(await h.send(h.request({ products })), 400, 'INVALID_REQUEST');
    assert.equal(h.calls.length, 0);
  });

test('Gateway rejects unknown top-level fields and malformed bodies/media', async () => {
  for (const body of [{ products: [ref()], extra: true }, [ref()], null, 123, {}]) {
    const h = harness(); await error(await h.send(h.request(body)), 400, 'INVALID_REQUEST'); assert.equal(h.calls.length, 0);
  }
  for (const body of ['{', '', new Uint8Array([0x7b, 0xff, 0x7d])]) {
    const h = harness(); await error(await h.send(h.request({}, { body })), 400, 'INVALID_REQUEST'); assert.equal(h.calls.length, 0);
  }
  for (const type of ['', 'text/plain', 'application/jsonp', 'application/json; charset=iso-8859-1']) {
    const h = harness(); await error(await h.send(h.request({}, { headers: { 'Content-Type': type } })), 415, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(h.calls.length, 0);
  }
  const h = harness(); assert.equal((await h.send(h.request(undefined, { headers: { 'Content-Type': 'Application/JSON; charset=UTF-8' } }))).status, 200);
});

test('Gateway bounds actual bytes, with missing or false Content-Length, including streamed body', async () => {
  const base = JSON.stringify({ products: [ref()] });
  for (const declared of [undefined, '1', String(MAX_BODY_BYTES)]) {
    for (const size of [MAX_BODY_BYTES, MAX_BODY_BYTES + 1]) {
      const h = harness(), body = base.padEnd(size, ' ');
      const response = await h.send(h.request({}, { body, headers: declared ? { 'Content-Length': declared } : {} }));
      if (size === MAX_BODY_BYTES) assert.equal(response.status, 200);
      else { await error(response, 413, 'BODY_TOO_LARGE'); assert.equal(h.calls.length, 0); }
    }
  }
  const h = harness(); await error(await h.send(h.request(undefined, { headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } })), 413, 'BODY_TOO_LARGE');
  await error(await h.send(h.request(undefined, { headers: { 'Content-Length': 'oops' } })), 400, 'INVALID_REQUEST');
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  const r = new Request(`http://gateway.test${ROUTE}`, { method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Type': 'application/json' } } as any);
  await error(await h.send(r), 413, 'BODY_TOO_LARGE'); assert(cancelled); assert.equal(h.calls.length, 0);
});

test('Gateway routes, methods, query and Allow', async () => {
  const h = harness();
  await error(await h.send(h.request({}, {}, '/unknown')), 404, 'NOT_FOUND');
  for (const method of ['GET', 'PUT', 'HEAD', 'DELETE']) {
    const response = await h.send(h.request({}, { method, body: undefined }));
    assert.equal(response.headers.get('Allow'), 'POST, OPTIONS'); await error(response, 405, 'METHOD_NOT_ALLOWED');
  }
  await error(await h.send(h.request({}, {}, `${ROUTE}?x=1`)), 400, 'INVALID_REQUEST');
  assert.equal(h.calls.length, 0);
});

test('Gateway exact origin allowlist, null, no origin, and CORS on errors', async () => {
  for (const bad of ['null', 'https://evil.test', `${origin}.evil.test`, `${origin}/`]) {
    const h = harness(); const r = await h.send(h.request(undefined, { headers: { Origin: bad } }));
    await error(r, 403, 'ORIGIN_NOT_ALLOWED'); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(h.calls.length, 0); assert.equal(h.checks.length, 0);
  }
  const h = harness(); assert.equal((await h.send()).status, 200);
  const response = await h.send(h.request({ products: [] }, { headers: { Origin: origin } }));
  await error(response, 400, 'INVALID_REQUEST'); assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Vary'), 'Origin'); assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'Retry-After, X-Request-ID');
});

test('Gateway preflight validates path, method and requested headers without downstream calls', async () => {
  const h = harness();
  const preflight = (headers = {}, path = ROUTE) => h.request({}, { method: 'OPTIONS', body: undefined,
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type', ...headers } }, path);
  const response = await h.send(preflight()); assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  await error(await h.send(preflight({}, '/bad')), 404, 'NOT_FOUND');
  await error(await h.send(preflight({ 'Access-Control-Request-Method': 'GET' })), 400, 'INVALID_REQUEST');
  for (const header of ['Authorization', 'content-type,x-secret', ''])
    await error(await h.send(preflight({ 'Access-Control-Request-Headers': header })), 400, 'INVALID_REQUEST');
  await error(await h.send(h.request({}, { method: 'OPTIONS', body: undefined })), 400, 'INVALID_REQUEST');
  await error(await h.send(preflight({ Origin: 'null' })), 403, 'ORIGIN_NOT_ALLOWED');
  assert.equal(h.calls.length, 0); assert.equal(h.checks.length, 0);
});

for (const name of LIMITERS) test(`Gateway fails closed / denies for ${name}`, async () => {
  for (const mode of ['missing', 'throw', 'malformed', 'deny']) {
    const h = harness();
    (h.env as any)[name] = mode === 'missing' ? undefined : { limit: async () => {
      if (mode === 'throw') throw new Error('SECRET SQL https://private');
      return mode === 'malformed' ? { success: 'true' } : { success: false };
    } };
    const response = await h.send(h.request({ products: Array(21).fill(ref()) }, { headers: { Origin: origin } }));
    await error(response, mode === 'deny' ? 429 : 503, mode === 'deny' ? 'RATE_LIMITED' : 'PRICING_UNAVAILABLE');
    if (mode === 'deny') assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin); assert.equal(h.calls.length, 0);
    if (mode === 'missing') {
      await error(await h.send(), 503, 'PRICING_UNAVAILABLE');
      assert.equal(h.calls.length, 0); assert.equal(h.checks.length, 0);
    }
  }
});

test('Gateway normal/large limits and keys do not trust X-Forwarded-For', async () => {
  const h = harness();
  await h.send(h.request(undefined, { headers: { 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': 'untrusted' } }));
  await h.send(h.request(undefined, { headers: { 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': 'different' } }));
  assert.equal(h.checks[0].key, h.checks[2].key); assert(!h.checks[0].key.includes('192.0.2.1'));
  assert.equal(h.checks[1].key, 'summary:all');
  await h.send(); assert.equal(h.checks.at(-2)!.key, 'summary:anonymous');
  await h.send(h.request({ products: Array(100).fill(ref()) }));
  assert.deepEqual(h.checks.slice(-4).map(c => c.name), LIMITERS);
  assert.equal(h.checks.at(-1)!.key, 'summary:large');
});

test('Gateway invalid configuration, stop switch and missing RPC fail closed', async () => {
  for (const patch of [{ SUMMARY_ENABLED: 'false' }, { SUMMARY_ENABLED: '' }, { SUMMARY_ENABLED: undefined },
    { ALLOWED_ORIGINS: '*' }, { ALLOWED_ORIGINS: '["null"]' }, { ALLOWED_ORIGINS: '["http://localhost:5173/"]' },
    { ALLOWED_ORIGINS: undefined }, { PRICING: undefined }, { PRICING: {} }, { CLIENT_LIMITER: undefined }]) {
    const h = harness(); Object.assign(h.env, patch);
    await error(await h.send(), 503, 'PRICING_UNAVAILABLE'); assert.equal(h.calls.length, 0); assert.equal(h.checks.length, 0);
  }
});

test('Gateway maps RPC errors/exceptions/malformed results safely without retry', async () => {
  const invalid = { ok: false, error: { code: 'INVALID_REQUEST', message: 'SECRET' } };
  for (const result of [invalid, { ok: false, error: { code: 'PRICING_UNAVAILABLE', stack: 'SECRET' } },
    new Error('SECRET SQL https://private'), null, {}, { ok: 'true' }, { ok: true, data: [] },
    { ok: true, data: [null] }, fixtures.pending, { ok: false, error: { code: 'SECRET' } },
    { ok: true, data: [{ ...ref(), providers: {} }] },
    { ok: true, data: [{ ...ref(), providers: { yahoo: { ...fixtures.pending.data[0].providers.yahoo, stale: 'yes' } } }] }]) {
    const h = harness(); let count = 0;
    h.env.PRICING.getPriceSummaries = async () => { count++; if (result instanceof Error) throw result; return result as any; };
    await error(await h.send(), result === invalid ? 400 : 503, result === invalid ? 'INVALID_REQUEST' : 'PRICING_UNAVAILABLE');
    assert.equal(count, 1); assert(!JSON.stringify(h.logs).includes('SECRET'));
  }
});

test('Gateway does not expose unknown downstream fields or sensitive request metadata in logs', async () => {
  const h = harness();
  h.env.PRICING.getPriceSummaries = async () => ({ ...fixtures.pending, secret: 'SECRET', data: [{
    ...fixtures.pending.data[0], secret: 'SECRET', providers: { yahoo: { ...fixtures.pending.data[0].providers.yahoo, secret: 'SECRET' } },
  }] });
  const response = await h.send(h.request(fixtures.request, { headers: { 'CF-Connecting-IP': '192.0.2.123' } }));
  assert.deepEqual(await response.json(), fixtures.pending);
  assert.equal(h.logs.length, 1); assert.equal(h.logs[0].batch_count, 1);
  assert(!/SECRET|192\.0\.2|test-fixture|57800/.test(JSON.stringify(h.logs)));
});

test('Gateway rejects malformed summary fields, nullability and positional correspondence', async () => {
  const good = fixtures['fresh-complete'].data[0];
  const changes = [{ provider: 'other' }, { status: 'invalid' }, { lowest_price: -1 }, { lowest_price: null },
    { offer_count: 1.5 }, { fetched_at: 'SECRET' }, { fetched_at: null }, { expires_at: null }, { stale: undefined }];
  for (const change of changes) {
    const h = harness();
    h.env.PRICING.getPriceSummaries = async () => ({ ok: true, data: [{ ...good, providers: { yahoo: { ...good.providers.yahoo, ...change } } }] });
    await error(await h.send(h.request(fixtures.request)), 503, 'PRICING_UNAVAILABLE');
  }
  const h = harness();
  h.env.PRICING.getPriceSummaries = async refs => ({ ok: true, data: [...refs].reverse().map(r => ({ ...r, providers: good.providers })) });
  await error(await h.send(h.request({ products: [ref(1), ref(2)] })), 503, 'PRICING_UNAVAILABLE');
});

test('the actual initial config remains stopped at the HTTP boundary without RPC or limiter calls', async () => {
  const cfg = readGatewayConfig(INITIAL_CONFIG, 'initial'), h = harness();
  assert.deepEqual(cfg.vars, { ALLOWED_ORIGINS: '[]', SUMMARY_ENABLED: 'false' });
  Object.assign(h.env, cfg.vars);
  await error(await h.send(), 503, 'PRICING_UNAVAILABLE');
  assert.equal(h.calls.length, 0); assert.equal(h.checks.length, 0);
  assert(!readFileSync('src/gateway/worker.ts', 'utf8').includes('test/'));
});
