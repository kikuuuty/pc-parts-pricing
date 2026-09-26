import { POLICY } from '../config';
import type { Catalog } from '../catalog/client';
import type { PriceProvider, RefreshMessage } from '../pricing/model';
import { validateMessage } from '../pricing/model';
import { fresh, refreshTier } from '../pricing/freshness';
import { RefreshError } from '../providers/errors';
import type { SummaryStore } from '../storage/summaries';
import type { Log } from '../telemetry';

export class Consumer {
  constructor(private store: SummaryStore, private catalog: Catalog, private provider: PriceProvider,
    private log: Log, private now = Date.now) {}

  async process(input: unknown): Promise<void> {
    let message: RefreshMessage;
    try { message = validateMessage(input); }
    catch { this.log({ event: 'queue', queue_result: 'invalid' }); return; }
    const current = (await this.store.lookup([message]))[0];
    if (!current || current.queue_token !== message.token) {
      this.log({ event: 'queue', provider: message.provider, reason: message.reason, queue_result: 'skipped' });
      return;
    }
    if (fresh(current, this.now())) {
      await this.store.release(message, Math.max(current.expires_at!, current.next_refresh_at === current.queued_until ? 0 : current.next_refresh_at), this.now());
      this.log({ event: 'queue', provider: message.provider, reason: message.reason, queue_result: 'skipped' });
      return;
    }
    const runToken = crypto.randomUUID();
    const row = await this.store.acquire(message, this.now(), runToken);
    // A concurrent delivery owns the execution; retry rather than acknowledge it.
    if (!row) throw new RefreshError('storage');
    try {
      const identifiers = await this.catalog.identifiers(message);
      const result = identifiers === null ? { status: 'missing' as const, lowest_price: null, offer_count: 0,
        fetched_at: null, expires_at: this.now() + POLICY.missingInterval } : await this.provider.lookup(identifiers);
      const now = this.now(), tier = refreshTier(row, now);
      const negative = result.status === 'unsupported' || result.status === 'missing';
      const next = negative ? result.expires_at : Math.max(result.expires_at, now + tier.interval);
      const saved = await this.store.finish(message, runToken, result, next, negative ? 3 : tier.priority, now);
      this.log({ event: 'queue', provider: message.provider, reason: message.reason,
        queue_result: saved ? 'saved' : 'skipped', summary_status: result.status, offer_count: result.offer_count });
    } catch (error) {
      // Storage failures must not be ACKed as provider failures. The run lease
      // expires before Queue's native retry; a cached provider result can be reused.
      if (!(error instanceof RefreshError) || error.reason === 'storage') throw new RefreshError('storage');
      const delay = Math.max(error.retryAfter * 1000,
        Math.min(POLICY.failureMax, POLICY.failureBase * 2 ** Math.min(row.failure_count, 8)));
      await this.store.fail(message, runToken, error.reason, this.now() + delay, this.now());
      this.log({ event: 'queue', provider: message.provider, reason: message.reason,
        queue_result: 'deferred', refresh_reason: error.reason });
    }
  }
}
