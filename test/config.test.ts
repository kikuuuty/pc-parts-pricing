import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { config } from '../src/config';

test('deployment is private, uses explicit catalog boundary and bounded Queue/Cron', () => {
  const value = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  assert.equal(value.workers_dev, false); assert.equal(value.preview_urls, false);
  assert.deepEqual(value.routes, []); assert.equal(value.services[0].service, 'pc-parts-catalog');
  assert(!JSON.stringify(value.vars).includes('APP_ID'));
  assert.equal(value.d1_databases.length, 1);
  assert.equal(value.queues.consumers[0].max_concurrency, 1);
  assert.equal(value.queues.consumers[0].max_batch_size, 1);
  assert(value.queues.consumers[0].retry_delay * 1000 > 120000);
  assert.deepEqual(value.triggers.crons, ['*/15 * * * *']);
  config(value.vars);
});

test('live smoke is disabled unless explicitly opted in', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/smoke-yahoo.ts'], { encoding: 'utf8',
    env: { ...process.env, YAHOO_SHOPPING_APP_ID: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Live access is disabled/);
});
