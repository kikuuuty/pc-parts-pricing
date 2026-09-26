export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const SQL_CHUNK_SIZE = 50;
// Keep each internal RPC comfortably below Free's 50 D1 queries, including failures.
export const RPC_CHUNK_SIZE = 250;
export function* chunks<T>(values: T[], size = SQL_CHUNK_SIZE): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}
export const POLICY = Object.freeze({
  hotInterval: 6 * HOUR, recentInterval: DAY, monthInterval: 3 * DAY, coldInterval: 14 * DAY,
  hotAccessBuckets: 3, touchInterval: HOUR, unsupportedInterval: 14 * DAY, missingInterval: DAY,
  queueLease: 25 * HOUR, runLease: 300_000, failureBase: 900_000, failureMax: 6 * HOUR,
  defaultInterval: DAY, syncCategoriesPerTick: 4,
});
export interface Config {
  ttl: number; maxStale: number; cronBatch: number; warmupBatch: number;
  queueDaily: number; yahooDaily: number; yahooMinute: number; pacing: number;
  defaultPageSize: number; defaultSyncInterval: number;
}
export type Variables = Partial<Record<
  'YAHOO_SUMMARY_TTL_SECONDS' | 'MAX_STALE_SECONDS' | 'CRON_BATCH_SIZE' | 'WARMUP_BATCH_SIZE' |
  'QUEUE_DAILY_LIMIT' | 'YAHOO_DAILY_LIMIT' | 'YAHOO_MINUTE_LIMIT' | 'YAHOO_PACING_MS' |
  'DEFAULT_PAGE_WARMUP_SIZE' | 'DEFAULT_PAGE_SYNC_SECONDS', string>>;
export function config(env: Variables): Config {
  const n = (key: keyof Variables, fallback: number, min: number, max: number) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || +raw < min || +raw > max) throw new Error('INVALID_CONFIG');
    return +raw;
  };
  return {
    ttl: n('YAHOO_SUMMARY_TTL_SECONDS', 21600, 60, 1209600) * 1000,
    maxStale: n('MAX_STALE_SECONDS', 604800, 0, 2592000) * 1000,
    cronBatch: n('CRON_BATCH_SIZE', 8, 1, 20), warmupBatch: n('WARMUP_BATCH_SIZE', 1, 0, 5),
    defaultPageSize: n('DEFAULT_PAGE_WARMUP_SIZE', 20, 1, 50),
    defaultSyncInterval: n('DEFAULT_PAGE_SYNC_SECONDS', 21600, 3600, 604800) * 1000,
    queueDaily: n('QUEUE_DAILY_LIMIT', 1000, 1, 1000),
    yahooDaily: n('YAHOO_DAILY_LIMIT', 1500, 1, 3000),
    yahooMinute: n('YAHOO_MINUTE_LIMIT', 30, 1, 30), pacing: n('YAHOO_PACING_MS', 1000, 1000, 10000),
  };
}
