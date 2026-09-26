import { DAY, type Config } from '../config';
import { RefreshError } from '../providers/errors';
import type { Log } from '../telemetry';

export const nextDay = (now: number) => (Math.floor(now / DAY) + 1) * DAY;
interface Budget { day: number; day_count: number; minute: number; minute_count: number; next_allowed_at: number }

export async function reserveQueue(db: D1Database, count: number, now: number, limit: number): Promise<boolean> {
  return !!await db.prepare(`UPDATE work_budget SET day=?1,
    day_count=CASE WHEN day=?1 THEN day_count+?2 ELSE ?2 END
    WHERE name='queue' AND (CASE WHEN day=?1 THEN day_count ELSE 0 END)+?2<=?3 RETURNING name`)
    .bind(Math.floor(now / DAY), count, limit).first();
}

export class YahooBudget {
  constructor(private db: D1Database, private cfg: Config, private log: Log,
    private now = Date.now, private sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {}

  async admit(): Promise<void> {
    // Only a short pacing wait is allowed. Minute/day/cooldown limits defer work to Cron.
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = this.now(), day = Math.floor(now / DAY), minute = Math.floor(now / 60_000);
      const accepted = await this.db.prepare(`UPDATE work_budget SET day=?1,minute=?2,
        day_count=CASE WHEN day=?1 THEN day_count+1 ELSE 1 END,
        minute_count=CASE WHEN minute=?2 THEN minute_count+1 ELSE 1 END,next_allowed_at=?3
        WHERE name='yahoo' AND next_allowed_at<=?4
          AND (day!=?1 OR day_count<?5) AND (minute!=?2 OR minute_count<?6) RETURNING name`)
        .bind(day, minute, now + this.cfg.pacing, now, this.cfg.yahooDaily, this.cfg.yahooMinute).first();
      if (accepted) {
        this.log({ event: 'provider', provider: 'yahoo', rate_limit_status: 'allowed' });
        return;
      }
      const state = await this.db.prepare("SELECT * FROM work_budget WHERE name='yahoo'").first<Budget>();
      if (!state) throw new RefreshError('protection');
      const daily = state.day === day && state.day_count >= this.cfg.yahooDaily;
      const minutely = state.minute === minute && state.minute_count >= this.cfg.yahooMinute;
      const wait = Math.max(1, state.next_allowed_at - now);
      const status = daily ? 'daily' : minutely ? 'minute' : wait > this.cfg.pacing ? 'cooldown' : 'pacing';
      this.log({ event: 'provider', provider: 'yahoo', rate_limit_status: status });
      if (status !== 'pacing' || attempt === 2) {
        const until = daily ? nextDay(now) : minutely ? (minute + 1) * 60_000 : state.next_allowed_at;
        throw new RefreshError('rate_limit', Math.max(1, Math.ceil((until - now) / 1000)));
      }
      await this.sleep(wait);
    }
  }

  async cooldown(seconds: number): Promise<void> {
    await this.db.prepare("UPDATE work_budget SET next_allowed_at=MAX(next_allowed_at,?) WHERE name='yahoo'")
      .bind(this.now() + seconds * 1000).run();
  }
}
