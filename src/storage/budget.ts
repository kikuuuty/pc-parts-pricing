import { DAY, type Config } from '../config';
import { RefreshError } from '../providers/errors';
import type { Log } from '../telemetry';
import type { Lane } from '../pricing/model';

export const nextDay = (now: number) => (Math.floor(now / DAY) + 1) * DAY;
interface Budget { day: number; day_count: number; minute: number; minute_count: number; next_allowed_at: number;
  background_day_count: number; background_minute_count: number }
// Shared total caps remain authoritative. Separate lane ceilings reserve capacity
// without polling the product table or depending on Queue delivery order.
export function laneLimit(total: number, lane: Lane, period: 'day' | 'minute'): number {
  return Math.max(1, Math.floor(total * (lane === 'interactive' ? 0.8 : period === 'day' ? 0.6 : 0.2)));
}

export async function reserveQueue(db: D1Database, count: number, now: number, limit: number, lane: Lane = 'interactive'): Promise<boolean> {
  return !!await db.prepare(`UPDATE work_budget SET day=?1,
    day_count=CASE WHEN day=?1 THEN day_count+?2 ELSE ?2 END,
    background_day_count=CASE WHEN day=?1 THEN background_day_count ELSE 0 END+?4
    WHERE name='queue' AND (CASE WHEN day=?1 THEN day_count ELSE 0 END)+?2<=?3
      AND (CASE WHEN day=?1 THEN ${lane === 'background' ? 'background_day_count' : 'day_count-background_day_count'} ELSE 0 END)+?2<=?5
    RETURNING name`)
    .bind(Math.floor(now / DAY), count, limit, lane === 'background' ? count : 0, laneLimit(limit, lane, 'day')).first();
}

export class YahooBudget {
  private deadline: number;
  constructor(private db: D1Database, private cfg: Config, private log: Log,
    private now = Date.now, private sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    private lane: Lane = 'interactive') { this.deadline = now() + 240_000; }

  async admit(): Promise<void> {
    // Minute/pacing waits stay in this consumer; ordinary demand never waits for Cron.
    // Bounded attempts + deadline fit within the execution lease and Free D1 limit.
    for (let attempt = 0; attempt < 6; attempt++) {
      const now = this.now(), day = Math.floor(now / DAY), minute = Math.floor(now / 60_000);
      const accepted = await this.db.prepare(`UPDATE work_budget SET day=?1,minute=?2,
        day_count=CASE WHEN day=?1 THEN day_count+1 ELSE 1 END,
        minute_count=CASE WHEN minute=?2 THEN minute_count+1 ELSE 1 END,next_allowed_at=?3,
        background_day_count=CASE WHEN day=?1 THEN background_day_count ELSE 0 END+?7,
        background_minute_count=CASE WHEN minute=?2 THEN background_minute_count ELSE 0 END+?7
        WHERE name='yahoo' AND next_allowed_at<=?4
          AND (day!=?1 OR day_count<?5) AND (minute!=?2 OR minute_count<?6)
          AND (day!=?1 OR ${this.lane === 'background' ? 'background_day_count' : 'day_count-background_day_count'}<?8)
          AND (minute!=?2 OR ${this.lane === 'background' ? 'background_minute_count' : 'minute_count-background_minute_count'}<?9)
        RETURNING name`)
        .bind(day, minute, now + this.cfg.pacing, now, this.cfg.yahooDaily, this.cfg.yahooMinute,
          this.lane === 'background' ? 1 : 0, laneLimit(this.cfg.yahooDaily, this.lane, 'day'),
          laneLimit(this.cfg.yahooMinute, this.lane, 'minute')).first();
      if (accepted) {
        this.log({ event: 'provider', provider: 'yahoo', rate_limit_status: 'allowed' });
        return;
      }
      const state = await this.db.prepare("SELECT * FROM work_budget WHERE name='yahoo'").first<Budget>();
      if (!state) throw new RefreshError('protection');
      const laneDay = this.lane === 'background' ? state.background_day_count : state.day_count - state.background_day_count;
      const laneMinute = this.lane === 'background' ? state.background_minute_count : state.minute_count - state.background_minute_count;
      const daily = state.day === day && (state.day_count >= this.cfg.yahooDaily || laneDay >= laneLimit(this.cfg.yahooDaily, this.lane, 'day'));
      const minutely = state.minute === minute && (state.minute_count >= this.cfg.yahooMinute || laneMinute >= laneLimit(this.cfg.yahooMinute, this.lane, 'minute'));
      const wait = Math.max(1, state.next_allowed_at - now);
      const status = daily ? 'daily' : wait > this.cfg.pacing ? 'cooldown' : minutely ? 'minute' : 'pacing';
      this.log({ event: 'provider', provider: 'yahoo', rate_limit_status: status });
      const until = daily ? nextDay(now) : Math.max(state.next_allowed_at, minutely ? (minute + 1) * 60_000 : now + wait);
      if (daily || status === 'cooldown' || attempt === 5 || until > this.deadline) {
        throw new RefreshError('rate_limit', Math.max(1, Math.ceil((until - now) / 1000)));
      }
      await this.sleep(Math.max(1, until - now));
    }
  }

  async cooldown(seconds: number): Promise<void> {
    await this.db.prepare("UPDATE work_budget SET next_allowed_at=MAX(next_allowed_at,?) WHERE name='yahoo'")
      .bind(this.now() + seconds * 1000).run();
  }
}
