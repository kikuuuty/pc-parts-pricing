import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { TestContext } from 'node:test';
import { config, DAY } from '../src/config';
import { SummaryStore } from '../src/storage/summaries';
import { Enqueuer } from '../src/queue/enqueue';
import { PricingService } from '../src/pricing/service';
import type { ProductRef, RefreshMessage, Row, Status } from '../src/pricing/model';
import type { Event } from '../src/telemetry';

export const ref = (n = 1): ProductRef => ({ source: 'buildcores', upstream_key: `CPU/test-${n}` });
export const JAN = '0012345678905', EAN = '0730143315289';
export const codes = [JAN, EAN, '0840353046559', '4718466015815'];
export const identifier = (value = JAN, type = 'jan', region = 'all', origin = 'upstream') => ({ value, type, region, origin });
export const hit = (changes: Record<string, unknown> = {}) => ({
  janCode: JAN, code: 'shop_item', name: 'Private product', url: 'https://example.com/item',
  price: 57800, seller: { sellerId: 'shop', name: 'Private seller' }, inStock: true, condition: 'new', ...changes,
});
export const body = (hits: unknown[] = [hit()]) => ({ totalResultsAvailable: hits.length, totalResultsReturned: hits.length, hits });

export function harness(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new NodeURL('../migrations/0001_pricing.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const statements: string[] = [], logs: Event[] = [], messages: RefreshMessage[] = [];
  let time = 100 * DAY, failSql: RegExp | null = null;
  const execute = (sql: string, values: SQLInputValue[]) => {
    statements.push(sql);
    if (failSql?.test(sql)) { failSql = null; throw new Error('private D1 failure'); }
    return sqlite.prepare(sql).all(...values);
  };
  const db = { prepare(sql: string) {
    const statement = (values: SQLInputValue[]) => ({
      bind: (...params: SQLInputValue[]) => statement(params),
      all: async () => ({ results: execute(sql, values), success: true }),
      first: async () => execute(sql, values)[0] ?? null,
      run: async () => ({ results: execute(sql, values), success: true }),
    });
    return statement([]);
  } } as unknown as D1Database;
  let sendFails = false;
  const queue = { sendBatch: async (batch: { body: RefreshMessage }[]) => {
    if (sendFails) throw new Error('private queue failure');
    messages.push(...batch.map(m => m.body));
  } } as unknown as Queue<RefreshMessage>;
  const cfg = config({}), now = () => time, log = (event: Event) => logs.push(event);
  const store = new SummaryStore(db), enqueuer = new Enqueuer(store, queue, cfg, log, now);
  const service = new PricingService(store, enqueuer, cfg, log, now);
  const tasks: Promise<unknown>[] = [];
  return { sqlite, db, queue, statements, logs, messages, cfg, now, log, store, enqueuer, service,
    advance: (ms: number) => { time += ms; },
    fail: (pattern: RegExp) => { failSql = pattern; }, sendFails: () => { sendFails = true; },
    read: (input: unknown) => service.getPriceSummaries(input, task => tasks.push(task)),
    flush: async () => { await Promise.all(tasks.splice(0)); },
    row: (r = ref()) => sqlite.prepare('SELECT * FROM product_price_summary WHERE source=? AND upstream_key=?').get(r.source, r.upstream_key) as unknown as Row,
    put: (r = ref(), status: Status = 'complete', overrides: Partial<Row> = {}) => {
      const value: Row = {
        ...r, provider: 'yahoo', status, lowest_price: status === 'complete' ? 57800 : null,
        offer_count: status === 'complete' ? 2 : status === 'pending' ? null : 0,
        fetched_at: status === 'complete' || status === 'empty' ? time - 1000 : null,
        expires_at: status === 'pending' ? null : time + cfg.ttl, last_requested_at: time,
        access_window_at: time, access_count: 1, priority: 1, next_refresh_at: time + cfg.ttl,
        retry_after: 0, queue_token: null, queued_until: 0, run_token: null, run_until: 0,
        failure_count: 0, last_error: null, created_at: time, updated_at: time, ...overrides,
      };
      sqlite.prepare(`INSERT OR REPLACE INTO product_price_summary (${Object.keys(value).join(',')}) VALUES (${Object.keys(value).map(() => '?').join(',')})`)
        .run(...Object.values(value));
      return value;
    },
  };
}
export function memoryCache(): Cache {
  const entries = new Map<string, Response>();
  return {
    async match(key: string) { return entries.get(key)?.clone(); },
    async put(key: string, response: Response) { entries.set(key, response.clone()); },
  } as unknown as Cache;
}
