import test from 'node:test';
import assert from 'node:assert/strict';
import { localGateway } from '../scripts/gateway-local';
import { INITIAL_CONFIG, readGatewayConfig } from '../scripts/gateway-config';

for (const rpc of [false, true]) test(`offline Gateway development driver starts/stops (${rpc ? 'real RPC' : 'mock'})`, { timeout: 60000 }, async t => {
  const mf = await localGateway(rpc, 'fresh-complete', 0);
  t.after(() => mf.dispose());
  // Use a real loopback HTTP client too, so the documented developer endpoint
  // is tested, not only Miniflare's dispatch adapter.
  const url = new URL('/v1/prices/summary', await mf.ready);
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify({ products: [{ source: 'buildcores', upstream_key: 'CPU/test-local' }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).data[0].providers.yahoo.status, rpc ? 'pending' : 'complete');
  if (!rpc) {
    // Real native Rate Limiting binding in workerd, not an in-memory JS mock.
    let denied = false;
    // Allow a local window boundary without assuming an exact reset instant.
    const limit = readGatewayConfig(INITIAL_CONFIG, 'initial').ratelimits.find(r => r.name === 'CLIENT_LIMITER')!.simple.limit;
    for (let i = 0; i < 2 * limit + 1 && !denied; i++) {
      const next = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products: [{ source: 'buildcores', upstream_key: 'CPU/test-local' }] }),
      });
      assert([200, 429].includes(next.status));
      if (next.status === 429) {
        denied = true;
        assert.equal(next.headers.get('Retry-After'), '60');
        assert.deepEqual(await next.json(), { ok: false, error: { code: 'RATE_LIMITED' } });
      }
      else await next.arrayBuffer();
    }
    assert(denied, 'local native limiter must eventually reject');
  }
});
