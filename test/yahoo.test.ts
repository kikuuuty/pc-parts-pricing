import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates, validEan13, validJan } from '../src/providers/yahoo/identifiers';
import { fetchYahoo, normalize } from '../src/providers/yahoo/transport';
import { CandidateCache, YahooProvider } from '../src/providers/yahoo/service';
import { YahooBudget } from '../src/storage/budget';
import { RefreshError } from '../src/providers/errors';
import { DAY } from '../src/config';
import { body, codes, EAN, harness, hit, identifier, JAN, memoryCache } from './helpers';

test('JAN validation and strict EAN-13 fallback preserve leading zeros and canonical metadata', () => {
  assert(validJan(` ${JAN} `)); assert(validJan('00123457')); assert(validEan13(EAN));
  for (const value of [null, 730143315289, '730143315289', '00123457', ` ${EAN}`, `${EAN} `,
    '００１２３４５６７８９０５', '0000000000000', '0730143315288', '0' + EAN, '0730-143315289']) assert(!validEan13(value));
  const input = [identifier(EAN, 'ean'), identifier(` ${JAN} `), identifier('part-name', 'mpn')];
  const before = structuredClone(input);
  assert.deepEqual(candidates(input), [{ strategy: 'jan', value: JAN }, { strategy: 'ean13_as_jan', value: EAN }]);
  assert.deepEqual(input, before);
  for (const region of ['us', '', 'eu']) assert.deepEqual(candidates([identifier(EAN, 'ean', region)]), []);
});

test('candidate order is type > region > grouped local provenance > lexical; dedup before limit', () => {
  const inputs = [identifier(codes[3], 'jan', 'all', 'local'), identifier(codes[2], 'jan', 'jp'),
    { ...identifier(EAN, 'jan', 'jp'), origins: [{ origin: 'local' }, { origin: 'upstream' }] },
    identifier(JAN, 'jan', 'jp', 'local'), identifier(JAN, 'ean', 'jp', 'local'), identifier(EAN, 'ean')];
  assert.deepEqual(candidates(inputs).map(c => c.value), [JAN, EAN, codes[2]]);
  assert.deepEqual(candidates([...inputs].reverse()), candidates(inputs));
  // Each of the eight ranking levels wins over the subsequent one.
  const levels = ['jan', 'ean'].flatMap(type => ['jp', 'all'].flatMap(region => ['local', 'upstream'].map(origin => ({ type, region, origin }))));
  for (let i = 0; i < levels.length - 1; i++) {
    assert.equal(candidates([{ ...levels[i + 1], value: JAN }, { ...levels[i], value: EAN }])[0].value, EAN);
  }
});

test('exact matches, stock/new filters, duplicate listings and minimal summary normalization', () => {
  const result = normalize(body([
    hit({ price: 60000 }), hit({ price: 58000 }), hit({ code: 'other', price: 59000 }),
    hit({ code: 'out', inStock: false, price: 1 }), hit({ condition: 'used', price: 1 }),
    ...[undefined, '', Number(JAN), JAN.slice(1), ` ${JAN} `, EAN].map(janCode => hit({ janCode, price: 1 })),
  ]), JAN);
  assert.deepEqual(result, { lowest_price: 58000, offer_count: 2 });
  assert.deepEqual(normalize(body([hit({ janCode: EAN })]), JAN), { lowest_price: null, offer_count: 0 });
});

test('schema corruption is an error, never an empty summary', () => {
  for (const value of [{}, { hits: [] }, body([null]), body([hit({ price: '5' })]), body([hit({ inStock: 'true' })]),
    body([hit({ url: 'javascript:alert(1)' })]), body([hit({ seller: {} })]), body(Array(51).fill(hit())),
    { ...body([]), totalResultsReturned: 1 }]) assert.throws(() => normalize(value, JAN), RefreshError);
});

test('transport uses exact filters and manual redirects; telemetry never contains private values', async t => {
  const h = harness(t);
  const result = await fetchYahoo('secret-test-only', JAN, h.log, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'shopping.yahooapis.jp');
    assert.equal(url.searchParams.get('jan_code'), JAN);
    assert.equal(url.searchParams.get('appid'), 'secret-test-only');
    assert.equal(url.searchParams.get('sort'), '+price');
    assert.equal(url.searchParams.get('results'), '50');
    assert.equal(url.searchParams.get('condition'), 'new');
    assert.equal(url.searchParams.get('in_stock'), 'true');
    assert.equal(url.searchParams.has('query'), false);
    assert.equal(init?.redirect, 'manual');
    assert(init?.signal);
    return Response.json(body());
  });
  assert.equal(result.lowest_price, 57800);
  const output = JSON.stringify([h.logs, result]);
  for (const value of [JAN, 'secret-test-only', 'Private', 'https:', 'seller']) assert(!output.includes(value));
});

export const failures: [string, typeof fetch][] = [
  ['timeout', async () => new Promise(() => {})],
  ['network', async () => { throw new Error('private failure'); }],
  ['upstream_429', async () => new Response('private body', { status: 429, headers: { 'Retry-After': '120' } })],
  ['upstream_5xx', async () => new Response('private body', { status: 503 })],
  ['upstream_4xx', async () => new Response('private body', { status: 403 })],
  ['upstream_status', async () => new Response(null, { status: 302, headers: { Location: 'https://private.example' } })],
  ['invalid_json', async () => new Response('private invalid JSON')],
  ['malformed_response', async () => Response.json({})],
];
for (const [reason, fetcher] of failures) {
  test(`transport/fallback error ${reason} stops at candidate #2 and is never cached`, async t => {
    const h = harness(t), local = new CandidateCache();
    let calls = 0, tokens = 0, cooldown = 0;
    const provider = new YahooProvider(h.cfg, 'secret-test-only', {
      admit: async () => { tokens++; }, cooldown: async seconds => { cooldown = seconds; },
    }, h.log, undefined, local, h.now,
    async (...args) => ++calls === 1 ? Response.json(body([])) : fetcher(...args), 10);
    await assert.rejects(provider.lookup(codes.map(code => identifier(code, 'ean'))), error => {
      assert(error instanceof RefreshError); assert.equal(error.reason, reason);
      assert(!/private|https|secret|stack/.test(error.message)); return true;
    });
    assert.equal(calls, 2); assert.equal(tokens, 2); assert.equal(local.completed.size, 1);
    assert.equal(local.inflight.size, 0);
    if (reason === 'upstream_429') assert.equal(cooldown, 120);
  });
}

test('timeout also covers a stalled response body', async () => {
  await assert.rejects(fetchYahoo('test', JAN, () => {}, async () => new Response(new ReadableStream({ start() {} })), 10),
    (error: RefreshError) => error.reason === 'timeout');
});

test('invalid Retry-After is clamped and unsupported requires no secret/token', async t => {
  const h = harness(t);
  for (const retry of ['0', '-1', '99999', 'Fri, 1 Jan', '1.5']) {
    await assert.rejects(fetchYahoo('test', JAN, h.log,
      async () => new Response('', { status: 429, headers: { 'Retry-After': retry } })),
    (error: RefreshError) => error.reason === 'upstream_429' && error.retryAfter === 60);
  }
  let tokens = 0;
  const provider = new YahooProvider(h.cfg, undefined, { admit: async () => { tokens++; }, cooldown: async () => {} }, h.log);
  assert.equal((await provider.lookup([identifier('name', 'mpn')])).status, 'unsupported');
  await assert.rejects(provider.lookup([identifier()]), (e: RefreshError) => e.reason === 'missing_app_id');
  assert.equal(tokens, 0);
});

for (const hitAt of [0, 1, 2, 3, 4]) {
  test(`bounded fallback hit ${hitAt}: first nonempty only, empty cache reuse and earliest expiry`, async t => {
    const h = harness(t), cache = memoryCache(), queried: string[] = [];
    const make = (appId: string | undefined, local = new CandidateCache()) => new YahooProvider(h.cfg, appId,
      new YahooBudget(h.db, h.cfg, h.log, h.now, async ms => h.advance(ms)), h.log, cache, local, h.now,
      async input => {
        const code = new URL(String(input)).searchParams.get('jan_code')!; queried.push(code);
        return Response.json(body(code === codes[hitAt - 1] ? [hit({ janCode: code })] : []));
      });
    const start = h.now(), first = await make('test').lookup(codes.map(code => identifier(code, 'ean')));
    const attempts = hitAt > 0 && hitAt <= 3 ? hitAt : 3;
    assert.equal(queried.length, attempts);
    assert.equal(first.status, hitAt > 0 && hitAt <= 3 ? 'complete' : 'empty');
    assert.equal(first.expires_at, start + h.cfg.ttl);
    h.advance(5000);
    assert.deepEqual(await make(undefined).lookup(codes.map(code => identifier(code, 'ean'))), first);
    assert.equal(queried.length, attempts);
  });
}

test('same candidate coalesces parallel misses and failures without leaking inflight keys', async t => {
  const h = harness(t);
  for (const fail of [false, true]) {
    let calls = 0, tokens = 0, release!: () => void;
    const block = new Promise<void>(resolve => { release = resolve; });
    const provider = new YahooProvider(h.cfg, 'test', { admit: async () => { tokens++; }, cooldown: async () => {} },
      h.log, undefined, new CandidateCache(), h.now, async () => {
        calls++; await block; return fail ? new Response('', { status: 500 }) : Response.json(body());
      });
    const tasks = Array.from({ length: 10 }, () => provider.lookup([identifier()]));
    await new Promise(resolve => setTimeout(resolve, 20)); release();
    const results = await Promise.allSettled(tasks);
    assert(results.every(r => r.status === (fail ? 'rejected' : 'fulfilled')));
    assert.equal(calls, 1); assert.equal(tokens, 1);
  }
  assert(h.logs.some(e => e.candidate_cache === 'coalesced'));
});

test('candidate caches separate JAN/EAN strategy and expire without TTL extension', async t => {
  const h = harness(t); let calls = 0;
  const provider = new YahooProvider(h.cfg, 'test', { admit: async () => {}, cooldown: async () => {} }, h.log,
    undefined, new CandidateCache(), h.now, async () => { calls++; return Response.json(body()); });
  await provider.lookup([identifier()]); await provider.lookup([identifier(JAN, 'ean')]);
  assert.equal(calls, 2);
  h.advance(h.cfg.ttl);
  await provider.lookup([identifier()]); assert.equal(calls, 3);
});

test('catalog A3 mesh EAN #2 regression and Ryzen leading-zero EAN use exact Yahoo jan_code', async t => {
  const h = harness(t), queried: string[] = [];
  const provider = new YahooProvider(h.cfg, 'test', { admit: async () => {}, cooldown: async () => {} },
    h.log, undefined, new CandidateCache(), h.now, async input => {
      const code = new URL(String(input)).searchParams.get('jan_code')!; queried.push(code);
      return Response.json(body(code === '0840353046559' ? [] : [hit({ janCode: code })]));
    });
  const a3 = await provider.lookup(['0840353046559', '4718466015815'].map(code => identifier(code, 'ean')));
  assert.equal(a3.status, 'complete'); assert.deepEqual(queried, ['0840353046559', '4718466015815']);
  const ryzen = await provider.lookup([identifier(EAN, 'ean'), identifier('100-100001084WOF', 'mpn'), identifier('730143315289', 'upc')]);
  assert.equal(ryzen.status, 'complete'); assert.equal(queried.at(-1), '0730143315289');
});

test('cache match/put failures never bypass Yahoo admission', async t => {
  const h = harness(t); let tokens = 0;
  const cache = { match: async () => { throw Error('private'); }, put: async () => { throw Error('private'); } } as unknown as Cache;
  const provider = new YahooProvider(h.cfg, 'test', { admit: async () => { tokens++; }, cooldown: async () => {} },
    h.log, cache, new CandidateCache(), h.now, async () => Response.json(body()));
  assert.equal((await provider.lookup([identifier()])).status, 'complete'); assert.equal(tokens, 1);
});

test('D1 pacing is shared across independent budgets; minute/day limits and 429 cooldown fail closed', async t => {
  const h = harness(t), waits: number[] = [];
  const make = () => new YahooBudget(h.db, h.cfg, h.log, h.now, async ms => { waits.push(ms); h.advance(ms); });
  await make().admit(); await make().admit();
  assert.deepEqual(waits, [1000]);
  h.cfg.yahooMinute = 2;
  await assert.rejects(make().admit(), (e: RefreshError) => e.reason === 'rate_limit');
  h.advance(60000); h.cfg.yahooDaily = 2;
  await assert.rejects(make().admit(), (e: RefreshError) => e.retryAfter > 3600);
  h.advance(DAY); await make().admit();
  await make().cooldown(120);
  await assert.rejects(make().admit(), (e: RefreshError) => e.retryAfter === 120);
  h.advance(120000); await make().admit();
  h.sqlite.exec("DELETE FROM work_budget WHERE name='yahoo'");
  await assert.rejects(make().admit(), (e: RefreshError) => e.reason === 'protection');
});

test('D1 admission errors never call the Provider', async t => {
  const h = harness(t); h.fail(/UPDATE work_budget/); let calls = 0;
  const provider = new YahooProvider(h.cfg, 'test', new YahooBudget(h.db, h.cfg, h.log, h.now), h.log,
    undefined, new CandidateCache(), h.now, async () => { calls++; return Response.json(body()); });
  await assert.rejects(provider.lookup([identifier()])); assert.equal(calls, 0);
});
