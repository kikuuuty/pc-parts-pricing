import type { PricingRpc } from '../pricing/contracts';

export interface GatewayEnv {
  PRICING: Pick<PricingRpc, 'getPriceSummaries'>;
  CLIENT_LIMITER: RateLimit;
  GLOBAL_LIMITER: RateLimit;
  LARGE_CLIENT_LIMITER: RateLimit;
  LARGE_GLOBAL_LIMITER: RateLimit;
  ALLOWED_ORIGINS: string;
  SUMMARY_ENABLED: string;
}

export const LIMITERS = ['CLIENT_LIMITER', 'GLOBAL_LIMITER', 'LARGE_CLIENT_LIMITER', 'LARGE_GLOBAL_LIMITER'] as const;
export type LimiterResult = 'not_checked' | 'allowed' | 'denied' | 'unavailable';
export const RETRY_AFTER = '60'; // All four deployed windows are 60 seconds; approximate, not a reset time.
export const LARGE_BATCH = 20;

export function allowedOrigins(value: string): string[] {
  const origins: unknown = JSON.parse(value);
  if (!Array.isArray(origins) || origins.some(origin => {
    if (typeof origin !== 'string') return true;
    try {
      const url = new URL(origin);
      return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin;
    } catch { return true; }
  })) throw new Error('CONFIG');
  return origins;
}

export function ready(env: GatewayEnv): boolean {
  return env.SUMMARY_ENABLED === 'true' && typeof env.PRICING?.getPriceSummaries === 'function' &&
    LIMITERS.every(name => typeof env[name]?.limit === 'function');
}

export async function clientKey(request: Request): Promise<string> {
  // Only Cloudflare's edge-provided header, never X-Forwarded-For or a user key.
  // Missing edge identity (e.g. local dev) shares one conservative bucket.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return 'summary:anonymous';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return `summary:client:${Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('')}`;
}

export async function checkLimit(limiter: RateLimit, key: string): Promise<boolean> {
  const result = await limiter.limit({ key });
  if (!result || typeof result.success !== 'boolean') throw new Error('LIMITER');
  return result.success;
}
