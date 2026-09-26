import type { Config } from '../config';
import { SummaryStore } from '../storage/summaries';
import { nextDay, reserveQueue } from '../storage/budget';
import type { ProductRef, RefreshMessage, RefreshReason } from '../pricing/model';
import type { Log } from '../telemetry';

export class Enqueuer {
  constructor(private store: SummaryStore, private queue: Queue<RefreshMessage>, private cfg: Config,
    private log: Log, private now = Date.now) {}

  async enqueue(refs: ProductRef[], reason: RefreshReason): Promise<number> {
    if (!refs.length) return 0;
    const now = this.now(), token = crypto.randomUUID();
    const claimed = await this.store.claim(refs, now, token, reason === 'scheduled_refresh' || reason === 'cold_warmup');
    const messages: RefreshMessage[] = claimed.map(row => ({ source: row.source, upstream_key: row.upstream_key,
      provider: row.provider, reason, token }));
    if (!messages.length) {
      this.log({ event: 'enqueue', provider: 'yahoo', reason, queue_result: 'deduplicated', count: 0 });
      return 0;
    }
    // Claim first: duplicate viewers do not consume the global enqueue budget.
    if (!await reserveQueue(this.store.db, messages.length, now, this.cfg.queueDaily)) {
      for (const message of messages) await this.store.release(message, nextDay(now), now);
      this.log({ event: 'enqueue', provider: 'yahoo', reason, queue_result: 'budget', count: messages.length });
      return 0;
    }
    try {
      await this.queue.sendBatch(messages.map(body => ({ body, contentType: 'json' })));
    } catch {
      // Sending and D1 are not a distributed transaction. Token fencing makes an
      // ambiguously delivered old message harmless; crashed claims expire via Cron.
      for (const message of messages) await this.store.release(message, now + 900_000, now);
      this.log({ event: 'enqueue', provider: 'yahoo', reason, queue_result: 'error', count: messages.length });
      return 0;
    }
    this.log({ event: 'enqueue', provider: 'yahoo', reason, queue_result: 'sent', count: messages.length });
    return messages.length;
  }
}
