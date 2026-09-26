import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

test('0002 upgrades populated 0001 without losing prices, identities, leases or budget consumption', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync('migrations/0001_pricing.sql', 'utf8'));
  db.exec(`INSERT INTO product_price_summary
    (source,upstream_key,provider,status,lowest_price,offer_count,fetched_at,expires_at,last_requested_at,
      next_refresh_at,created_at,updated_at,queue_token,queued_until)
    VALUES ('buildcores','CPU/existing','yahoo','complete',50000,2,100,200,150,300,50,100,'existing-token',300);
    UPDATE work_budget SET day=1,day_count=123,minute_count=5,next_allowed_at=500 WHERE name='yahoo';`);
  const before = db.prepare('SELECT * FROM product_price_summary').get()!;
  const budget = db.prepare("SELECT * FROM work_budget WHERE name='yahoo'").get()!;
  db.exec(readFileSync('migrations/0002_demand_warmup.sql', 'utf8'));
  const after = db.prepare('SELECT * FROM product_price_summary').get()!;
  for (const [key, value] of Object.entries(before)) assert.equal(after[key], value);
  assert.equal(after.is_default, 0); assert.equal(after.queue_lane, 'background');
  const next = db.prepare("SELECT * FROM work_budget WHERE name='yahoo'").get()!;
  for (const [key, value] of Object.entries(budget)) assert.equal(next[key], value);
  assert.equal(next.background_day_count, 0);
});
