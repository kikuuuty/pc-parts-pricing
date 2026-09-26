import { DAY, type Config } from '../config';
import type { Enqueuer } from '../queue/enqueue';
import type { SummaryStore } from '../storage/summaries';
import type { Row, RefreshReason } from '../pricing/model';
import type { Log } from '../telemetry';

export async function schedule(store: SummaryStore, enqueue: Enqueuer, cfg: Config, log: Log, now = Date.now()): Promise<void> {
  let remaining = cfg.cronBatch, count = 0, coldRemaining = cfg.warmupBatch;
  const submit = async (rows: Row[]) => {
    remaining -= rows.length;
    const groups = new Map<RefreshReason, Row[]>();
    for (const row of rows) {
      const reason: RefreshReason = row.queue_lane === 'interactive' && row.last_requested_at !== null && now - row.last_requested_at < DAY
        ? 'user_request' : row.is_default ? 'default_warmup'
        : row.status === 'pending' && row.last_requested_at === null ? 'cold_warmup' : 'scheduled_refresh';
      groups.set(reason, [...(groups.get(reason) ?? []), row]);
    }
    for (const [reason, group] of groups) count += await enqueue.enqueue(group, reason);
  };
  // Reserve one background slot hourly for cold and one for each recent tier.
  // The remaining slots always prefer the default set. No full-table scans/sorts.
  const fairTier = [0, 1, 2, 3][Math.floor(now / 900_000) % 4];
  if (fairTier < 3 || coldRemaining > 0) {
    const rows = await store.due(fairTier, now, 1);
    await submit(rows);
    if (fairTier === 3) coldRemaining -= rows.length;
  }
  await submit(await store.defaultDue(now, remaining));
  for (let priority = 0; priority <= 3 && remaining > 0; priority++) {
    await submit(await store.due(priority, now, priority === 3 ? Math.min(remaining, coldRemaining) : remaining));
  }
  log({ event: 'scheduler', count });
}
