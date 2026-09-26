import { RefreshError, retryAfter } from '../errors';
import { boundedJson, object, withTimeout } from '../http';
import type { Event, Log } from '../../telemetry';

export interface YahooSummary { lowest_price: number | null; offer_count: number }
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function safeUrl(value: unknown): value is string {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
export function normalize(body: unknown, code: string): YahooSummary {
  if (!object(body) || !Array.isArray(body.hits) || body.hits.length > 50 ||
    !Number.isSafeInteger(body.totalResultsReturned) || body.totalResultsReturned !== body.hits.length ||
    !Number.isSafeInteger(body.totalResultsAvailable) || (body.totalResultsAvailable as number) < body.hits.length)
    throw new RefreshError('malformed_response');
  const listings = new Map<string, number>();
  for (const hit of body.hits) {
    if (!object(hit)) throw new RefreshError('malformed_response');
    if (typeof hit.janCode !== 'string' || hit.janCode !== code) continue;
    if (hit.inStock === false || hit.condition === 'used') continue;
    if (!text(hit.code) || !text(hit.name) || !safeUrl(hit.url) || !Number.isSafeInteger(hit.price) ||
      (hit.price as number) <= 0 || hit.inStock !== true || hit.condition !== 'new' || !object(hit.seller) ||
      !text(hit.seller.sellerId) || !text(hit.seller.name)) throw new RefreshError('malformed_response');
    const key = JSON.stringify([hit.seller.sellerId, hit.code, hit.url]);
    listings.set(key, Math.min(listings.get(key) ?? Infinity, hit.price as number));
  }
  return { lowest_price: listings.size ? Math.min(...listings.values()) : null, offer_count: listings.size };
}

export async function fetchYahoo(appId: string | undefined, code: string, log: Log,
  fetcher: typeof fetch = fetch, timeoutMs = 5000): Promise<YahooSummary> {
  if (!appId?.trim()) throw new RefreshError('missing_app_id', 3600);
  const url = new URL('https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch');
  url.search = new URLSearchParams({ appid: appId, jan_code: code, results: '50', in_stock: 'true',
    condition: 'new', sort: '+price' }).toString();
  const started = performance.now();
  const event: Event = { event: 'provider', provider: 'yahoo', provider_status_class: 'none' };
  try {
    return await withTimeout(async signal => {
      const response = await fetcher(url, { signal, redirect: 'manual' });
      event.provider_status_class = `${Math.floor(response.status / 100)}xx` as Event['provider_status_class'];
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 429) throw new RefreshError('upstream_429', retryAfter(response));
        if (response.status >= 500) throw new RefreshError('upstream_5xx');
        throw new RefreshError(response.status >= 400 ? 'upstream_4xx' : 'upstream_status');
      }
      return normalize(await boundedJson(response, 524288), code);
    }, timeoutMs);
  } finally {
    event.provider_duration_ms = Math.min(60000, Math.round(performance.now() - started));
    log(event);
  }
}
