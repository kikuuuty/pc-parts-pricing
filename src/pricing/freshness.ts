import { DAY, POLICY, type Config } from '../config';
import type { Row, Summary } from './model';

export function fresh(row: Row | undefined, now: number): boolean {
  return !!row && row.status !== 'pending' && row.expires_at !== null && row.expires_at > now;
}
export function needsRefresh(row: Row | undefined, now: number): boolean {
  return !row || (!fresh(row, now) && row.status !== 'unsupported' &&
    (row.queued_until <= now || (row.queue_lane === 'background' && row.run_until <= now)) && row.retry_after <= now);
}
export function summary(row: Row | undefined, now: number, cfg: Config): Summary {
  const stale = !!row && row.status !== 'pending' && !fresh(row, now);
  const usable = row && (fresh(row, now) || row.status === 'unsupported' ||
    (row.expires_at !== null && now < row.expires_at + cfg.maxStale && row.status !== 'missing'));
  return {
    provider: 'yahoo', status: usable ? row.status : 'pending',
    lowest_price: usable ? row.lowest_price : null, offer_count: usable ? row.offer_count : null,
    fetched_at: usable && row.fetched_at !== null ? new Date(row.fetched_at).toISOString() : null,
    expires_at: row?.expires_at != null ? new Date(row.expires_at).toISOString() : null, stale,
  };
}
export function refreshTier(row: Row, now: number): { priority: number; interval: number } {
  const age = row.last_requested_at === null ? Infinity : now - row.last_requested_at;
  if (row.is_default) return { priority: 0, interval: POLICY.defaultInterval };
  if (age < DAY && now - row.access_window_at < DAY && row.access_count >= POLICY.hotAccessBuckets)
    return { priority: 0, interval: POLICY.hotInterval };
  if (age < 7 * DAY) return { priority: 1, interval: POLICY.recentInterval };
  if (age < 30 * DAY) return { priority: 2, interval: POLICY.monthInterval };
  return { priority: 3, interval: POLICY.coldInterval };
}
