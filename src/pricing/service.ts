import { POLICY, type Config } from '../config';
import { fresh, needsRefresh, summary } from './freshness';
import { refKey, uniqueRefs, validateProducts, type ProductSummary, type RefreshReason, type Row } from './model';
import { SummaryStore } from '../storage/summaries';
import { Enqueuer } from '../queue/enqueue';
import type { Log } from '../telemetry';

export class PricingService {
  constructor(private store: SummaryStore, private enqueuer: Enqueuer, private cfg: Config,
    private log: Log, private now = Date.now) {}

  async getPriceSummaries(input: unknown, waitUntil: (task: Promise<unknown>) => void): Promise<ProductSummary[]> {
    const products = validateProducts(input), now = this.now();
    const rows = new Map((await this.store.lookup(products)).map(row => [refKey(row), row]));
    const refs = uniqueRefs(products);
    const touch = refs.filter(ref => {
      const row = rows.get(refKey(ref));
      return row?.last_requested_at == null || row.last_requested_at <= now - POLICY.touchInterval;
    });
    const refresh = refs.filter(ref => needsRefresh(rows.get(refKey(ref)), now));
    if (touch.length || refresh.length) waitUntil((async () => {
      if (touch.length) await this.store.touch(touch, now);
      await this.enqueuer.enqueue(refresh, 'user_request');
    })().catch(() => this.log({ event: 'background', queue_result: 'error' })));
    return products.map(ref => {
      const row: Row | undefined = rows.get(refKey(ref));
      const value = summary(row, now, this.cfg);
      this.log({ event: 'summary', provider: 'yahoo', summary_status: value.status,
        cache_status: !row ? 'missing' : row.status === 'unsupported' ? 'unsupported' :
          fresh(row, now) ? 'fresh' : row.status === 'pending' ? 'pending' : 'stale',
        refresh_reason: needsRefresh(row, now) ? row?.expires_at ? 'expired' : 'unfetched' : undefined });
      return { ...ref, providers: { yahoo: value } };
    });
  }

  async requestRefresh(input: unknown, reason: RefreshReason = 'manual'): Promise<{ enqueued: number }> {
    const products = validateProducts(input);
    await this.store.touch(products, this.now());
    return { enqueued: await this.enqueuer.enqueue(products, reason) };
  }

  async seedWarmup(input: unknown): Promise<{ registered: number }> {
    return { registered: await this.store.seed(validateProducts(input), this.now()) };
  }
}
