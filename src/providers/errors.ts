export type FailureReason = 'missing_app_id' | 'timeout' | 'network' | 'upstream_429' | 'upstream_5xx' |
  'upstream_4xx' | 'upstream_status' | 'invalid_json' | 'malformed_response' | 'rate_limit' |
  'catalog_unavailable' | 'catalog_invalid' | 'storage' | 'protection';
export class RefreshError extends Error {
  constructor(public readonly reason: FailureReason, public readonly retryAfter = 30) {
    super('PRICE_REFRESH_UNAVAILABLE');
  }
}
export const retryAfter = (response: Response): number => {
  const value = response.headers.get('Retry-After') ?? '';
  return /^\d{1,4}$/.test(value) && +value >= 1 && +value <= 3600 ? +value : 60;
};
