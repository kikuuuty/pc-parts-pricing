import { validateProducts, type ProductRef, type ProductSummary, type Summary } from '../pricing/model';
import { allowedOrigins, checkLimit, clientKey, LARGE_BATCH, ready, RETRY_AFTER,
  type GatewayEnv, type LimiterResult } from './protection';

export const ROUTE = '/v1/prices/summary';
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PRODUCTS = 100; // HTTP only; internal RPC remains unbounded/chunked.
type ErrorCode = 'INVALID_REQUEST' | 'ORIGIN_NOT_ALLOWED' | 'NOT_FOUND' | 'METHOD_NOT_ALLOWED' |
  'BODY_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'RATE_LIMITED' | 'PRICING_UNAVAILABLE';
const codes: Record<ErrorCode, number> = { INVALID_REQUEST: 400, ORIGIN_NOT_ALLOWED: 403, NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405, BODY_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415, RATE_LIMITED: 429, PRICING_UNAVAILABLE: 503 };
class HttpError extends Error { constructor(readonly code: ErrorCode) { super(code); } }
function fail(code: ErrorCode): never { throw new HttpError(code); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

async function products(request: Request): Promise<ProductRef[]> {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(request.headers.get('Content-Type') ?? ''))
    fail('UNSUPPORTED_MEDIA_TYPE');
  const length = request.headers.get('Content-Length');
  if (length !== null) {
    if (!/^\d+$/.test(length)) fail('INVALID_REQUEST');
    if (Number(length) > MAX_BODY_BYTES) fail('BODY_TOO_LARGE');
  }
  if (!request.body) fail('INVALID_REQUEST');
  const reader = request.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        fail('BODY_TOO_LARGE');
      }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail('INVALID_REQUEST');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try {
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!object(input) || Object.keys(input).length !== 1 || !Array.isArray(input.products) ||
      input.products.length < 1 || input.products.length > MAX_PRODUCTS) fail('INVALID_REQUEST');
    return validateProducts(input.products);
  } catch { return fail('INVALID_REQUEST'); }
}

// Validate structure/nullability and correspondence, not freshness/in-flight semantics.
// Project the public fields: unexpected downstream metadata never leaks to HTTP.
export function publicSummaries(value: unknown, refs: ProductRef[]): ProductSummary[] {
  if (!Array.isArray(value) || value.length !== refs.length) return fail('PRICING_UNAVAILABLE');
  const count = (v: unknown) => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
  const date = (v: unknown) => v === null || (typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)));
  return Array.from(value, (row: unknown, i) => {
    if (!object(row) || row.source !== refs[i].source || row.upstream_key !== refs[i].upstream_key ||
      !object(row.providers) || !object(row.providers.yahoo)) return fail('PRICING_UNAVAILABLE');
    const s = row.providers.yahoo;
    if (s.provider !== 'yahoo' || !['complete', 'empty', 'unsupported', 'pending', 'missing'].includes(s.status as string) ||
      !count(s.lowest_price) || !count(s.offer_count) || !date(s.fetched_at) || !date(s.expires_at) ||
      typeof s.stale !== 'boolean') return fail('PRICING_UNAVAILABLE');
    // Existing RPC nullability only. In particular do not relate stale/expiry to
    // status, compare timestamps to now, or require a running refresh.
    const validState = s.status === 'complete'
      ? typeof s.lowest_price === 'number' && s.lowest_price > 0 &&
        typeof s.offer_count === 'number' && s.offer_count > 0 && s.fetched_at !== null && s.expires_at !== null
      : s.status === 'pending'
        ? s.lowest_price === null && s.offer_count === null && s.fetched_at === null
        : s.lowest_price === null && s.offer_count === 0 && s.expires_at !== null &&
          (s.status === 'empty' ? s.fetched_at !== null : s.fetched_at === null);
    if (!validState) return fail('PRICING_UNAVAILABLE');
    const summary: Summary = { provider: 'yahoo', status: s.status as Summary['status'],
      lowest_price: s.lowest_price as number | null, offer_count: s.offer_count as number | null,
      fetched_at: s.fetched_at as string | null, expires_at: s.expires_at as string | null, stale: s.stale };
    return { ...refs[i], providers: { yahoo: summary } };
  });
}

export interface GatewayEvent {
  event: 'gateway'; request_id: string; route: typeof ROUTE | 'unmatched'; status: number;
  batch_count: number; duration_ms: number; limiter: LimiterResult; error_code?: ErrorCode;
}
export async function handle(request: Request, env: GatewayEnv,
  log: (event: GatewayEvent) => void = event => console.log(JSON.stringify(event))): Promise<Response> {
  const start = Date.now(), id = crypto.randomUUID(), headers = new Headers({
    'Cache-Control': 'no-store', 'X-Request-ID': id, Vary: 'Origin',
  });
  let batch = 0, limiter: LimiterResult = 'not_checked', route: GatewayEvent['route'] = 'unmatched';
  const respond = (status: number, body: unknown, code?: ErrorCode) => {
    log({ event: 'gateway', request_id: id, route, status, batch_count: batch,
      duration_ms: Date.now() - start, limiter, ...(code ? { error_code: code } : {}) });
    return body === null ? new Response(null, { status, headers }) : Response.json(body, { status, headers });
  };
  try {
    let origins: string[];
    try { origins = allowedOrigins(env.ALLOWED_ORIGINS); } catch { return fail('PRICING_UNAVAILABLE'); }
    const origin = request.headers.get('Origin');
    if (origin !== null) {
      if (origin === 'null' || !origins.includes(origin)) fail('ORIGIN_NOT_ALLOWED');
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Expose-Headers', 'Retry-After, X-Request-ID');
    }
    const url = new URL(request.url);
    if (url.pathname !== ROUTE) fail('NOT_FOUND');
    route = ROUTE;
    if (url.search) fail('INVALID_REQUEST');
    if (request.method !== 'POST' && request.method !== 'OPTIONS') {
      headers.set('Allow', 'POST, OPTIONS'); fail('METHOD_NOT_ALLOWED');
    }
    if (!['true', 'false'].includes(env.SUMMARY_ENABLED)) fail('PRICING_UNAVAILABLE');
    if (request.method === 'OPTIONS') {
      headers.append('Vary', 'Access-Control-Request-Method');
      headers.append('Vary', 'Access-Control-Request-Headers');
      if (!origin || request.headers.get('Access-Control-Request-Method') !== 'POST') fail('INVALID_REQUEST');
      const requested = request.headers.get('Access-Control-Request-Headers');
      if (requested !== null && requested.split(',').some(h => h.trim().toLowerCase() !== 'content-type')) fail('INVALID_REQUEST');
      headers.set('Access-Control-Allow-Methods', 'POST');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      return respond(204, null);
    }
    if (!ready(env)) fail('PRICING_UNAVAILABLE');
    try {
      const key = await clientKey(request);
      // 12/client/min + 60/shared/min. A 20-ref page polled every 10s fits.
      // All requests spend the normal slots, including malformed/large bodies.
      limiter = 'unavailable';
      if (!await checkLimit(env.CLIENT_LIMITER, key) || !await checkLimit(env.GLOBAL_LIMITER, 'summary:all')) {
        limiter = 'denied'; fail('RATE_LIMITED');
      }
      limiter = 'allowed';
      const refs = await products(request);
      batch = refs.length;
      // >20: additionally 2/client/min + 6/shared/min. At most four binding calls,
      // never one call/ref. Nominal shared flow <=54*20+6*100=1680 refs/min/colo.
      if (batch > LARGE_BATCH) {
        limiter = 'unavailable';
        if (!await checkLimit(env.LARGE_CLIENT_LIMITER, key) || !await checkLimit(env.LARGE_GLOBAL_LIMITER, 'summary:large')) {
          limiter = 'denied'; fail('RATE_LIMITED');
        }
        limiter = 'allowed';
      }
      const result: unknown = await env.PRICING.getPriceSummaries(refs); // Exactly once; no transport retries.
      if (!object(result) || typeof result.ok !== 'boolean') fail('PRICING_UNAVAILABLE');
      if (!result.ok) {
        if ('data' in result) fail('PRICING_UNAVAILABLE');
        if (object(result.error) && result.error.code === 'INVALID_REQUEST') fail('INVALID_REQUEST');
        fail('PRICING_UNAVAILABLE');
      }
      if ('error' in result) fail('PRICING_UNAVAILABLE');
      return respond(200, { ok: true, data: publicSummaries(result.data, refs) });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail('PRICING_UNAVAILABLE');
    }
  } catch (error) {
    const code = error instanceof HttpError ? error.code : 'PRICING_UNAVAILABLE';
    if (code === 'RATE_LIMITED') headers.set('Retry-After', RETRY_AFTER);
    return respond(codes[code], { ok: false, error: { code } }, code);
  }
}
