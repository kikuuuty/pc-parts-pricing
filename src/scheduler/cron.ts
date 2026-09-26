import type { Config } from '../config';
import type { Enqueuer } from '../queue/enqueue';
import type { SummaryStore } from '../storage/summaries';
import type { Log } from '../telemetry';

export async function schedule(store: SummaryStore, enqueue: Enqueuer, cfg: Config, log: Log, now = Date.now()): Promise<void> {
  let remaining = cfg.cronBatch, count = 0;
  // Four bounded index range seeks, no ORDER BY expression across the catalog.
  // Cold rows share the last lane; at most warmupBatch of these per invocation.
  for (let priority = 0; priority <= 3 && remaining > 0; priority++) {
    const limit = priority === 3 ? Math.min(remaining, cfg.warmupBatch) : remaining;
    const rows = await store.due(priority, now, limit);
    remaining -= rows.length;
    for (const cold of [false, true]) {
      const group = rows.filter(row => (row.status === 'pending' && row.last_requested_at === null) === cold);
      count += await enqueue.enqueue(group, cold ? 'cold_warmup' : 'scheduled_refresh');
    }
  }
  log({ event: 'scheduler', count });
}
