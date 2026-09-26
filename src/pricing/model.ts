export type Provider = 'yahoo';
export type Status = 'complete' | 'empty' | 'unsupported' | 'pending' | 'missing';
export interface ProductRef { source: string; upstream_key: string }
export type RefreshReason = 'user_request' | 'default_warmup' | 'scheduled_refresh' | 'cold_warmup' | 'manual';
export type Lane = 'interactive' | 'background';
export const laneFor = (reason: RefreshReason): Lane =>
  reason === 'user_request' || reason === 'manual' ? 'interactive' : 'background';
export interface RefreshMessage extends ProductRef {
  provider: Provider;
  reason: RefreshReason;
  token: string;
}
export interface Summary {
  provider: Provider;
  status: Status;
  lowest_price: number | null;
  offer_count: number | null;
  fetched_at: string | null;
  expires_at: string | null;
  stale: boolean;
}
export interface ProductSummary extends ProductRef { providers: Record<Provider, Summary> }
export interface Row extends ProductRef {
  provider: Provider;
  status: Status;
  lowest_price: number | null;
  offer_count: number | null;
  fetched_at: number | null;
  expires_at: number | null;
  last_requested_at: number | null;
  access_window_at: number;
  access_count: number;
  priority: number;
  is_default: number;
  queue_lane: Lane;
  next_refresh_at: number;
  retry_after: number;
  queue_token: string | null;
  queued_until: number;
  run_token: string | null;
  run_until: number;
  failure_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
export interface Resolution {
  status: Exclude<Status, 'pending'>;
  lowest_price: number | null;
  offer_count: number;
  fetched_at: number | null;
  expires_at: number;
}
export interface Identifier {
  type: string;
  value: string;
  region: string;
  origin?: string;
  origins?: { origin: string }[];
}
export interface PriceProvider {
  lookup(identifiers: Identifier[]): Promise<Resolution>;
}
export const refKey = (ref: ProductRef) => JSON.stringify([ref.source, ref.upstream_key]);
export const uniqueRefs = (refs: ProductRef[]) => [...new Map(refs.map(ref => [refKey(ref), ref])).values()];

export function validateProducts(input: unknown): ProductRef[] {
  if (!Array.isArray(input) || input.length < 1) throw new Error('INVALID_REQUEST');
  return Array.from(input, ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== 2 ||
      typeof ref.source !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(ref.source) ||
      typeof ref.upstream_key !== 'string' || ref.upstream_key.length > 200 ||
      !/^[-A-Za-z0-9_]+\/[-A-Za-z0-9_.]+$/.test(ref.upstream_key) ||
      ['.', '..'].includes(ref.upstream_key.split('/')[1])) throw new Error('INVALID_REQUEST');
    return { source: ref.source, upstream_key: ref.upstream_key };
  });
}
export function validateMessage(value: unknown): RefreshMessage {
  const m = value as RefreshMessage;
  if (!m || typeof m !== 'object' || Object.keys(m).length !== 5 || m.provider !== 'yahoo' ||
    !['user_request', 'default_warmup', 'scheduled_refresh', 'cold_warmup', 'manual'].includes(m.reason) ||
    typeof m.token !== 'string' || !/^[a-f0-9-]{36}$/.test(m.token)) throw new Error('INVALID_MESSAGE');
  validateProducts([{ source: m.source, upstream_key: m.upstream_key }]);
  return m;
}
