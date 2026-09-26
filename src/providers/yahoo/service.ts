import { POLICY, type Config } from '../../config';
import type { Identifier, PriceProvider, Resolution } from '../../pricing/model';
import { RefreshError } from '../errors';
import { candidates, type Candidate } from './identifiers';
import { fetchYahoo, type YahooSummary } from './transport';
import type { Log } from '../../telemetry';

interface CandidateResult extends YahooSummary { fetched_at: number; expires_at: number }
interface Admission { admit(): Promise<void>; cooldown(seconds: number): Promise<void> }
export class CandidateCache {
  readonly inflight = new Map<string, Promise<CandidateResult>>();
  readonly completed = new Map<string, CandidateResult>();
}
// Bounded isolate hints; D1 summaries remain the authoritative product cache.
export const yahooCandidateCache = new CandidateCache();

export class YahooProvider implements PriceProvider {
  constructor(private cfg: Config, private appId: string | undefined, private budget: Admission,
    private log: Log, private cache?: Cache, private local = yahooCandidateCache,
    private now = Date.now, private fetcher: typeof fetch = fetch, private timeoutMs = 5000) {}

  async lookup(identifiers: Identifier[]): Promise<Resolution> {
    const choices = candidates(identifiers);
    if (!choices.length) return { status: 'unsupported', lowest_price: null, offer_count: 0,
      fetched_at: null, expires_at: this.now() + POLICY.unsupportedInterval };
    let expires = Infinity;
    for (const [index, choice] of choices.entries()) {
      const result = await this.candidate(choice);
      expires = Math.min(expires, result.expires_at);
      if (result.offer_count || index === choices.length - 1) return {
        ...result, status: result.offer_count ? 'complete' : 'empty', expires_at: expires,
      };
    }
    throw new RefreshError('malformed_response');
  }

  private async candidate(choice: Candidate): Promise<CandidateResult> {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(`${choice.strategy}:${choice.value}`)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const key = `https://pricing.internal/yahoo-summary/v1/${this.cfg.ttl}/${hash}`;
    const hint = this.local.completed.get(key);
    if (hint && hint.expires_at > this.now()) {
      this.log({ event: 'provider', provider: 'yahoo', candidate_cache: 'hit' });
      return hint;
    }
    this.local.completed.delete(key);
    const existing = this.local.inflight.get(key);
    if (existing) {
      this.log({ event: 'provider', provider: 'yahoo', candidate_cache: 'coalesced' });
      return existing;
    }
    if (this.local.inflight.size >= 32) throw new RefreshError('rate_limit', 60);
    const task = this.load(key, choice);
    this.local.inflight.set(key, task);
    try {
      const result = await task;
      if (this.local.completed.size >= 128) this.local.completed.delete(this.local.completed.keys().next().value!);
      this.local.completed.set(key, result);
      return result;
    } finally { this.local.inflight.delete(key); }
  }

  private async load(key: string, choice: Candidate): Promise<CandidateResult> {
    if (this.cache) {
      try {
        const hit = await this.cache.match(key);
        const result = hit ? await hit.json<CandidateResult>() : null;
        if (result && validCached(result, this.now(), this.cfg.ttl)) {
          this.log({ event: 'provider', provider: 'yahoo', candidate_cache: 'hit' });
          return result;
        }
      } catch { /* Cache failures still pass the durable admission gate. */ }
    }
    if (!this.appId?.trim()) throw new RefreshError('missing_app_id', 3600);
    this.log({ event: 'provider', provider: 'yahoo', candidate_cache: 'miss' });
    await this.budget.admit();
    let result: YahooSummary;
    try { result = await fetchYahoo(this.appId, choice.value, this.log, this.fetcher, this.timeoutMs); }
    catch (error) {
      if (error instanceof RefreshError && error.reason === 'upstream_429') await this.budget.cooldown(error.retryAfter);
      throw error;
    }
    const fetched_at = this.now();
    const value = { ...result, fetched_at, expires_at: fetched_at + this.cfg.ttl };
    if (this.cache) {
      try { await this.cache.put(key, Response.json(value, { headers: { 'Cache-Control': `max-age=${this.cfg.ttl / 1000}` } })); }
      catch { /* Product summary can still be committed to D1. */ }
    }
    return value;
  }
}

function validCached(result: CandidateResult, now: number, ttl: number): boolean {
  return Number.isSafeInteger(result.fetched_at) && result.fetched_at <= now &&
    result.expires_at === result.fetched_at + ttl && result.expires_at > now &&
    Number.isSafeInteger(result.offer_count) && result.offer_count >= 0 && result.offer_count <= 50 &&
    (result.offer_count === 0 ? result.lowest_price === null : Number.isSafeInteger(result.lowest_price) && result.lowest_price! > 0);
}
