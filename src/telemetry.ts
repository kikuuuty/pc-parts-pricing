import type { RefreshReason, Status } from './pricing/model';
import type { FailureReason } from './providers/errors';
export interface Event {
  event: 'summary' | 'enqueue' | 'queue' | 'provider' | 'scheduler' | 'background';
  provider?: 'yahoo'; reason?: RefreshReason; cache_status?: 'fresh' | 'stale' | 'missing' | 'pending' | 'unsupported';
  refresh_reason?: FailureReason | 'expired' | 'unfetched';
  queue_result?: 'sent' | 'deduplicated' | 'budget' | 'error' | 'skipped' | 'saved' | 'deferred' | 'invalid' | 'retry';
  provider_status_class?: '2xx' | '3xx' | '4xx' | '5xx' | 'none';
  provider_duration_ms?: number; summary_status?: Status; offer_count?: number;
  rate_limit_status?: 'allowed' | 'daily' | 'minute' | 'pacing' | 'cooldown';
  candidate_cache?: 'hit' | 'miss' | 'coalesced'; count?: number;
}
export type Log = (event: Event) => void;
// Callers construct this bounded model; never pass exceptions, refs or upstream objects.
export const log: Log = event => console.log(JSON.stringify(event));
