import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { config, POLICY } from '../src/config';

test('deployment is private, uses explicit catalog boundary and bounded Queue/Cron', () => {
  const value = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  assert.equal(value.workers_dev, false); assert.equal(value.preview_urls, false);
  assert.deepEqual(value.routes, []); assert.equal(value.services[0].service, 'pc-parts-catalog');
  assert(!JSON.stringify(value.vars).includes('APP_ID'));
  assert.equal(value.d1_databases.length, 1);
  assert.equal(value.queues.consumers[0].max_concurrency, 1);
  assert.equal(value.queues.consumers[0].max_batch_size, 1);
  assert.equal(value.queues.consumers.length, 2);
  for (const consumer of value.queues.consumers) {
    assert.equal(consumer.max_batch_size, 1); assert.equal(consumer.max_concurrency, 1);
    assert(consumer.retry_delay * 1000 > POLICY.runLease);
    assert.equal(consumer.dead_letter_queue, 'pc-parts-pricing-dead-letter');
  }
  assert.equal(value.queues.producers[0].queue, 'pc-parts-pricing-refresh');
  assert.equal(value.queues.producers[1].queue, 'pc-parts-pricing-interactive');
  assert.equal(value.services[1].entrypoint, 'PricingBatch');
  assert.deepEqual(value.triggers.crons, ['*/15 * * * *']);
  config(value.vars);
});

test('live smoke is disabled unless explicitly opted in', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/smoke-yahoo.ts'], { encoding: 'utf8',
    env: { ...process.env, YAHOO_SHOPPING_APP_ID: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Live access is disabled/);
});
