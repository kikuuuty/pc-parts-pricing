export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const POLICY = Object.freeze({
  hotInterval: 6 * HOUR, recentInterval: DAY, monthInterval: 3 * DAY, coldInterval: 14 * DAY,
  hotAccessBuckets: 3, touchInterval: HOUR, unsupportedInterval: 14 * DAY, missingInterval: DAY,
  queueLease: 25 * HOUR, runLease: 120_000, failureBase: 900_000, failureMax: 6 * HOUR,
});
export interface Config {
  ttl: number; maxStale: number; cronBatch: number; warmupBatch: number;
  queueDaily: number; yahooDaily: number; yahooMinute: number; pacing: number;
}
export type Variables = Partial<Record<
  'YAHOO_SUMMARY_TTL_SECONDS' | 'MAX_STALE_SECONDS' | 'CRON_BATCH_SIZE' | 'WARMUP_BATCH_SIZE' |
  'QUEUE_DAILY_LIMIT' | 'YAHOO_DAILY_LIMIT' | 'YAHOO_MINUTE_LIMIT' | 'YAHOO_PACING_MS', string>>;
export function config(env: Variables): Config {
  const n = (key: keyof Variables, fallback: number, min: number, max: number) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || +raw < min || +raw > max) throw new Error('INVALID_CONFIG');
    return +raw;
  };
  return {
    ttl: n('YAHOO_SUMMARY_TTL_SECONDS', 21600, 60, 1209600) * 1000,
    maxStale: n('MAX_STALE_SECONDS', 604800, 0, 2592000) * 1000,
    cronBatch: n('CRON_BATCH_SIZE', 4, 1, 20), warmupBatch: n('WARMUP_BATCH_SIZE', 1, 0, 5),
    queueDaily: n('QUEUE_DAILY_LIMIT', 1000, 1, 1000),
    yahooDaily: n('YAHOO_DAILY_LIMIT', 1500, 1, 3000),
    yahooMinute: n('YAHOO_MINUTE_LIMIT', 30, 1, 30), pacing: n('YAHOO_PACING_MS', 1000, 1000, 10000),
  };
}
