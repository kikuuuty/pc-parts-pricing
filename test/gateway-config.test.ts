import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { INITIAL_CONFIG, PRODUCTION_CONFIG, LIMITER_POLICY, readGatewayConfig,
  validateGatewayConfig, validateGatewayFiles } from '../scripts/gateway-config';
import { handle, ROUTE } from '../src/gateway/http';
import { LIMITERS, type GatewayEnv } from '../src/gateway/protection';

// Reserved, fictitious origins; never written into a deployment config.
const origins = ['https://sheet.example.test', 'https://other.example.test:8443'];
const production = (): any => structuredClone(readGatewayConfig(PRODUCTION_CONFIG, 'production'));
const base = (mode: 'initial' | 'production'): any => structuredClone(readGatewayConfig(
  mode === 'initial' ? INITIAL_CONFIG : PRODUCTION_CONFIG, mode));
const enabled = () => {
  const config = production();
  config.vars = { SUMMARY_ENABLED: 'true', ALLOWED_ORIGINS: JSON.stringify([origins[0]]) };
  return config;
};
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;

test('actual initial and production configurations pass the shared validator', () => {
  validateGatewayFiles();
  const initial = readGatewayConfig(INITIAL_CONFIG, 'initial');
  assert.deepEqual(initial.vars, { SUMMARY_ENABLED: 'false', ALLOWED_ORIGINS: '[]' });
  const stopped = production();
  stopped.vars = { SUMMARY_ENABLED: 'false', ALLOWED_ORIGINS: '[]' };
  validateGatewayConfig(stopped, 'production'); // Not a permanent assertion that production must be stopped.
});

test('production enablement, changed HTTPS origins and smaller limits are valid operational values', () => {
  for (const origin of origins) {
    const config = enabled();
    config.vars.ALLOWED_ORIGINS = JSON.stringify([origin]);
    config.ratelimits.find((r: any) => r.name === 'GLOBAL_LIMITER').simple.limit = 30;
    config.ratelimits.find((r: any) => r.name === 'LARGE_GLOBAL_LIMITER').simple.limit = 3;
    config.ratelimits.find((r: any) => r.name === 'LARGE_CLIENT_LIMITER').simple.limit = 1;
    validateGatewayConfig(config, 'production');
    // Neither array ordering nor one specific origin is an invariant.
    config.ratelimits.reverse();
    validateGatewayConfig(config, 'production');
  }
  for (const name of LIMITERS) {
    const config = enabled(); config.ratelimits.find((r: any) => r.name === name).simple.limit = 1;
    validateGatewayConfig(config, 'production');
  }
  assert.deepEqual(readGatewayConfig(INITIAL_CONFIG, 'initial').vars, { SUMMARY_ENABLED: 'false', ALLOWED_ORIGINS: '[]' });
});

test('only initial configuration is required to retain the exact stopped defaults', () => {
  const initial: any = structuredClone(readGatewayConfig(INITIAL_CONFIG, 'initial'));
  initial.vars.ALLOWED_ORIGINS = JSON.stringify([origins[0]]);
  assert.throws(() => validateGatewayConfig(initial, 'initial'));
  validateGatewayConfig(initial, 'production');
  initial.vars.SUMMARY_ENABLED = 'true';
  assert.throws(() => validateGatewayConfig(initial, 'initial'));
  validateGatewayConfig(initial, 'production');
});

for (const input of ['[]', '{', '{}', 'null', '[1]', '["*"]', '["null"]',
  ...['https://*.example.test', 'https://example.test/path', 'https://example.test/', 'https://example.test?x=1',
    'https://example.test#fragment', 'https://user:password@example.test', 'https://localhost', 'https://localhost:5173',
    'https://dev.localhost', 'https://localhost.', 'https://127.0.0.1', 'https://127.2.3.4:8788', 'https://0.0.0.0',
    'https://[::1]', 'https://[::]', 'https://[::ffff:7f00:1]', 'http://sheet.example.test', 'http://localhost:5173']
    .map(origin => JSON.stringify([origin]))])
  test(`production rejects unconfigured or unsafe origin: ${input}`, () => {
    const config = enabled(); config.vars.ALLOWED_ORIGINS = input;
    assert.throws(() => validateGatewayConfig(config, 'production'));
  });

test('production rejects development origins even while stopped; local HTTP origins remain valid at runtime', () => {
  const config = production(); config.vars = { SUMMARY_ENABLED: 'false', ALLOWED_ORIGINS: '["http://localhost:5173"]' };
  assert.throws(() => validateGatewayConfig(config, 'production'));
  // Local driver's allowlist is intentionally separate from production policy.
  assert(!readFileSync('scripts/gateway-local.ts', 'utf8').includes('PRODUCTION_CONFIG'));
  const valid = enabled(); valid.vars.ALLOWED_ORIGINS = '["https://127.example.test"]';
  validateGatewayConfig(valid, 'production'); // A fictitious DNS name is not a loopback IP.
});

for (const mode of ['initial', 'production'] as const) {
  test(`${mode}: invalid enable flags and extra vars are rejected`, () => {
    for (const flag of [undefined, null, true, false, '', 'TRUE', 'yes', 1]) {
      const config: any = structuredClone(readGatewayConfig(INITIAL_CONFIG, 'initial'));
      config.vars.SUMMARY_ENABLED = flag;
      assert.throws(() => validateGatewayConfig(config, mode));
    }
    const config = base(mode); config.vars.YAHOO_SHOPPING_APP_ID = 'must-not-be-in-gateway';
    assert.throws(() => validateGatewayConfig(config, mode));
    for (const field of ['SUMMARY_ENABLED', 'ALLOWED_ORIGINS']) {
      const missing = base(mode); delete missing.vars[field];
      assert.throws(() => validateGatewayConfig(missing, mode));
    }
  });

  test(`${mode}: binding, Worker identity and resource isolation are invariant`, () => {
    for (const patch of [
      { name: 'pc-parts-pricing-gateway-production' }, { main: 'src/worker.ts' }, { preview_urls: true },
      { services: [] }, { services: [{ binding: 'PRICING', service: 'other-worker', remote: false }] },
      ...['PricingAdmin', 'PricingBatch', 'default'].map(entrypoint => ({ services: [
        { binding: 'PRICING', service: 'pc-parts-pricing', remote: false, entrypoint },
      ] })),
      { services: [{ binding: 'PRICING', service: 'pc-parts-pricing', remote: true }] },
      { services: [...production().services, { binding: 'CATALOG', service: 'pc-parts-catalog' }] },
      { d1_databases: [] }, { queues: {} }, { triggers: { crons: [] } }, { secrets: ['YAHOO_SHOPPING_APP_ID'] },
      { env: { production: {} } }, { unsafe: {} },
    ]) assert.throws(() => validateGatewayConfig(Object.assign(base(mode), patch), mode));
  });

  test(`${mode}: limiter identities, uniqueness, positive safe limits and 60s windows are invariant`, () => {
    for (const name of LIMITERS) {
      for (const limit of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, LIMITER_POLICY[name].ceiling + 1]) {
        const config = base(mode); config.ratelimits.find((r: any) => r.name === name).simple.limit = limit;
        assert.throws(() => validateGatewayConfig(config, mode));
      }
      for (const period of [undefined, 10, 0, '60']) {
        const config = base(mode); config.ratelimits.find((r: any) => r.name === name).simple.period = period;
        assert.throws(() => validateGatewayConfig(config, mode));
      }
      const missing = base(mode); missing.ratelimits = missing.ratelimits.filter((r: any) => r.name !== name);
      assert.throws(() => validateGatewayConfig(missing, mode));
    }
    for (const mutate of [
      (c: any) => { c.ratelimits[1].namespace_id = c.ratelimits[0].namespace_id; },
      (c: any) => { c.ratelimits[1].name = c.ratelimits[0].name; },
      (c: any) => { c.ratelimits[0].namespace_id = '999'; },
      (c: any) => { [c.ratelimits[0].namespace_id, c.ratelimits[1].namespace_id] = [c.ratelimits[1].namespace_id, c.ratelimits[0].namespace_id]; },
      (c: any) => { c.ratelimits[0].name = 'UNKNOWN_LIMITER'; },
    ]) {
      const config = base(mode); mutate(config);
      assert.throws(() => validateGatewayConfig(config, mode));
    }
  });
}

test('a validated, fictitiously enabled production config works with unchanged HTTP/CORS semantics', async () => {
  const config = enabled(); validateGatewayConfig(config, 'production');
  const providers = JSON.parse(readFileSync('test/fixtures/gateway-http.json', 'utf8')).pending.data[0].providers;
  let calls = 0;
  const env = { ...config.vars,
    ...Object.fromEntries(LIMITERS.map(name => [name, { limit: async () => ({ success: true }) }])),
    PRICING: { getPriceSummaries: async (refs: any[]) => { calls++; return { ok: true, data: refs.map(ref => ({ ...ref, providers })) }; } },
  } as GatewayEnv;
  const request = (origin?: string) => new Request(`http://gateway.test${ROUTE}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ products: [{ source: 'buildcores', upstream_key: 'CPU/test-config' }] }),
  });
  assert.equal((await handle(request(origins[0]), env, () => {})).status, 200);
  assert.equal((await handle(request(origins[1]), env, () => {})).status, 403);
  assert.equal(calls, 1);
  assert.equal((await handle(request(), env, () => {})).status, 200); // Origin-less clients unchanged.
  env.SUMMARY_ENABLED = 'false';
  assert.equal((await handle(request(origins[0]), env, () => {})).status, 503);
  assert.equal(calls, 2);
});

test('build/deploy use guarded production config; CI also builds the actual initial config', () => {
  for (const command of ['build:gateway', 'deploy:gateway']) {
    assert(scripts[command].startsWith('npm run validate:gateway && wrangler deploy '));
    assert(scripts[command].includes(`--config ${PRODUCTION_CONFIG}`));
    assert(!scripts[command].includes('--env'));
  }
  assert(scripts['build:gateway'].includes('--dry-run'));
  assert(!scripts['deploy:gateway'].includes('--dry-run'));
  assert(scripts['build:gateway:initial'].startsWith('npm run validate:gateway && '));
  assert(scripts['build:gateway:initial'].includes(`--config ${INITIAL_CONFIG} --dry-run`));
  assert.equal(scripts['validate:gateway'], 'tsx scripts/check-gateway-config.ts');
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  for (const command of ['check', 'build', 'build:gateway', 'build:gateway:initial']) assert(ci.includes(`- run: npm run ${command}\n`));
});

test('actual validator CLI and npm gate stop invalid configuration before a MOCK deploy', { timeout: 30000 }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'pricing-gateway-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const initial = join(dir, INITIAL_CONFIG), prod = join(dir, PRODUCTION_CONFIG), marker = join(dir, 'called');
  writeFileSync(initial, readFileSync(INITIAL_CONFIG));
  const config = enabled(); config.ratelimits.find((r: any) => r.name === 'GLOBAL_LIMITER').simple.limit = 30;
  writeFileSync(prod, `// temporary, fictitious production config\n${JSON.stringify(config)}`);
  validateGatewayFiles(initial, prod); // JSONC and actual file loading, not a duplicate test validator.
  assert.deepEqual(readGatewayConfig(initial, 'initial').vars, { SUMMARY_ENABLED: 'false', ALLOWED_ORIGINS: '[]' });
  const require = createRequire(import.meta.url);
  const cli = resolve('scripts/check-gateway-config.ts'), tsx = pathToFileURL(require.resolve('tsx')).href;
  const mock = join(dir, 'mock-deploy.cjs');
  writeFileSync(mock, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'mock only');`);
  // Keep the real npm guard prefix. Replace ONLY Wrangler with a local marker:
  // no real deployment executable or Cloudflare API is ever invoked here.
  const command = scripts['deploy:gateway'].replace(/wrangler deploy .+$/, `node "${mock}"`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, scripts: {
    'validate:gateway': `node --import "${tsx}" "${cli}" "${initial}" "${prod}"`,
    'deploy:gateway': command,
  } }));
  const npm = process.env.npm_execpath;
  assert(npm, 'run via npm test / npm run check');
  const run = () => spawnSync(process.execPath, [join(dirname(npm), 'npm-cli.js'), 'run', 'deploy:gateway'], {
    cwd: dir, encoding: 'utf8', timeout: 10000, env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  // Invalid JSON and unsafe operational values all block the mock deploy.
  for (const text of ['{', JSON.stringify({ ...config, vars: { SUMMARY_ENABLED: 'true', ALLOWED_ORIGINS: '[]' } }),
    JSON.stringify({ ...config, vars: { SUMMARY_ENABLED: 'true', ALLOWED_ORIGINS: '["https://user:private-test-secret@example.test"]' } })]) {
    writeFileSync(prod, text);
    const result = run(); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert(result.stdout.includes('validate:gateway')); assert(!existsSync(marker));
    assert(!(result.stdout + result.stderr).includes('private-test-secret'));
  }
  writeFileSync(prod, JSON.stringify(config));
  const result = run(); assert.equal(result.status, 0, result.stdout + result.stderr); assert(existsSync(marker));
});
