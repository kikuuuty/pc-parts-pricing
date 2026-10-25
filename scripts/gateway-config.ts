// Offline deployment configuration checks, not part of the Gateway runtime.
import { readFileSync } from 'node:fs';
import { parseConfigFileTextToJson } from 'typescript';
import { allowedOrigins, LIMITERS, RETRY_AFTER } from '../src/gateway/protection';

export const INITIAL_CONFIG = 'wrangler.gateway.jsonc';
export const PRODUCTION_CONFIG = 'wrangler.gateway.production.jsonc';
// Fixed namespace identities; ceilings are safety guards, NOT required values.
// Lower limits are valid. Raising these original ceilings requires policy review.
export const LIMITER_POLICY = {
  CLIENT_LIMITER: { namespace: '2026102501', ceiling: 12 },
  GLOBAL_LIMITER: { namespace: '2026102502', ceiling: 60 },
  LARGE_CLIENT_LIMITER: { namespace: '2026102503', ceiling: 2 },
  LARGE_GLOBAL_LIMITER: { namespace: '2026102504', ceiling: 6 },
} as const;

export interface GatewayConfig {
  name: string; main: string; compatibility_date: string;
  vars: { ALLOWED_ORIGINS: string; SUMMARY_ENABLED: 'true' | 'false' };
  ratelimits: { name: typeof LIMITERS[number]; namespace_id: string; simple: { limit: number; period: 60 } }[];
}
function requireConfig(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Invalid Gateway config: ${reason}`);
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  requireConfig(object(value) && Object.keys(value).every(key => names.includes(key)), 'unexpected fields/resources');
}

export function validateGatewayConfig(value: unknown, mode: 'initial' | 'production'): asserts value is GatewayConfig {
  // No env/unsafe/alternate entrypoint/resources/secret declarations can hide
  // outside the binding checks. Keep this allowlist small and explicit.
  fields(value, ['$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'routes',
    'services', 'ratelimits', 'vars', 'observability']);
  requireConfig(value.name === 'pc-parts-pricing-gateway' && value.main === 'src/gateway/worker.ts', 'Worker identity');
  requireConfig(typeof value.compatibility_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.compatibility_date), 'compatibility date');
  requireConfig(value.workers_dev === true && value.preview_urls === false &&
    Array.isArray(value.routes) && value.routes.length === 0, 'public routing / Version URLs');
  requireConfig(Array.isArray(value.services) && value.services.length === 1, 'only PRICING binding is allowed');
  const service = value.services[0];
  fields(service, ['binding', 'service', 'remote']);
  requireConfig(service.binding === 'PRICING' && service.service === 'pc-parts-pricing' && service.remote === false,
    'PRICING must use the private default entrypoint with local development binding');
  fields(value.vars, ['ALLOWED_ORIGINS', 'SUMMARY_ENABLED']);
  requireConfig(value.vars.SUMMARY_ENABLED === 'true' || value.vars.SUMMARY_ENABLED === 'false', 'SUMMARY_ENABLED');
  requireConfig(typeof value.vars.ALLOWED_ORIGINS === 'string', 'ALLOWED_ORIGINS');
  let origins: string[];
  try { origins = allowedOrigins(value.vars.ALLOWED_ORIGINS); }
  catch { throw new Error('Invalid Gateway config: ALLOWED_ORIGINS'); }
  if (mode === 'initial') {
    requireConfig(value.vars.SUMMARY_ENABLED === 'false' && value.vars.ALLOWED_ORIGINS === '[]', 'initial config must stay stopped and unconfigured');
  } else {
    requireConfig(value.vars.SUMMARY_ENABLED !== 'true' || origins.length > 0, 'enabled production requires explicit origins');
    for (const origin of origins) {
      const url = new URL(origin), host = url.hostname.replace(/\.$/, '');
      requireConfig(url.protocol === 'https:' && !origin.includes('*') && !url.username && !url.password &&
        host !== 'localhost' && !host.endsWith('.localhost') && host !== 'localhost.localdomain' &&
        !host.endsWith('.localhost.localdomain') && !/^127\.\d+\.\d+\.\d+$/.test(host) && host !== '0.0.0.0' &&
        host !== '[::1]' && host !== '[::]' && !/^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host),
      'production requires HTTPS non-development origins');
    }
  }
  requireConfig(Array.isArray(value.ratelimits) && value.ratelimits.length === LIMITERS.length, 'required limiters');
  const names = new Set<string>(), namespaces = new Set<string>();
  for (const limiter of value.ratelimits) {
    fields(limiter, ['name', 'namespace_id', 'simple']);
    requireConfig(typeof limiter.name === 'string' && LIMITERS.includes(limiter.name as typeof LIMITERS[number]), 'limiter name');
    const name = limiter.name as typeof LIMITERS[number], policy = LIMITER_POLICY[name];
    requireConfig(!names.has(name) && typeof limiter.namespace_id === 'string' && !namespaces.has(limiter.namespace_id) &&
      limiter.namespace_id === policy.namespace, 'limiter namespace identity / uniqueness');
    names.add(name); namespaces.add(limiter.namespace_id);
    fields(limiter.simple, ['limit', 'period']);
    requireConfig(typeof limiter.simple.limit === 'number' && Number.isSafeInteger(limiter.simple.limit) &&
      limiter.simple.limit > 0 && limiter.simple.limit <= policy.ceiling, 'limiter limit must be positive and within its safety ceiling');
    requireConfig(limiter.simple.period === 60 && String(limiter.simple.period) === RETRY_AFTER, 'limiter period / Retry-After');
  }
}

export function readGatewayConfig(path: string, mode: 'initial' | 'production'): GatewayConfig {
  const parsed = parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  requireConfig(!parsed.error, 'invalid JSONC');
  const config: unknown = parsed.config;
  validateGatewayConfig(config, mode);
  return config;
}

export function validateGatewayFiles(initial = INITIAL_CONFIG, production = PRODUCTION_CONFIG): void {
  readGatewayConfig(initial, 'initial');
  readGatewayConfig(production, 'production');
}
