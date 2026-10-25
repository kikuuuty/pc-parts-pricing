-- One manual snapshot only; NOT a polling script.
-- Preconditions: confirmed schema; <=2000 summaries/memberships; reviewed 02-plan.
-- All persisted application timestamps are Unix milliseconds. day is UTC epoch day.
SELECT datetime('now') AS observed_at_utc;
SELECT c.category,COUNT(r.source) AS registered,datetime(c.next_sync_at/1000,'unixepoch') AS next_sync_utc
FROM default_warm_category c LEFT JOIN default_warm_ref r ON r.category=c.category GROUP BY c.category;
SELECT is_default,status,last_error,failure_count,COUNT(*) AS n,
 SUM(status!='pending' AND expires_at>unixepoch()*1000) AS fresh,
 SUM(status!='pending' AND expires_at<=unixepoch()*1000) AS stale,
 SUM(fetched_at IS NULL) AS no_fetched_at,
 SUM(next_refresh_at<=unixepoch()*1000) AS due,
 SUM(retry_after>unixepoch()*1000) AS backoff,
 SUM(queued_until>unixepoch()*1000) AS queue_lease,
 SUM(run_until>unixepoch()*1000) AS run_lease,
 MIN(fetched_at) AS min_fetched_ms,MAX(fetched_at) AS max_fetched_ms,
 MIN(next_refresh_at) AS min_next_ms,MAX(next_refresh_at) AS max_next_ms
FROM product_price_summary GROUP BY is_default,status,last_error,failure_count;
-- Independent flags above overlap; no_fetched_at is NOT proof of no processing.
SELECT COUNT(*) AS total,
 SUM(fetched_at>unixepoch()*1000 OR fetched_at>expires_at OR created_at>updated_at) AS invalid_time_order,
 SUM((queue_token IS NULL)!=(queued_until=0)) AS inconsistent_queue_lease,
 SUM((run_token IS NULL)!=(run_until=0) OR run_until>queued_until) AS inconsistent_run_lease,
 SUM(next_refresh_at<retry_after OR next_refresh_at<queued_until) AS next_before_gate,
 SUM(is_default!=EXISTS(SELECT 1 FROM default_warm_ref r WHERE r.source=s.source AND r.upstream_key=s.upstream_key)) AS registry_mismatch
FROM product_price_summary s;
SELECT name,day,date(day*86400,'unixepoch') AS stored_utc_date,day_count,background_day_count,
 CASE WHEN day=CAST(unixepoch()/86400 AS INTEGER) THEN day_count ELSE 0 END AS today_total,
 CASE WHEN day=CAST(unixepoch()/86400 AS INTEGER) THEN background_day_count ELSE 0 END AS today_background,
 CASE WHEN day=CAST(unixepoch()/86400 AS INTEGER) THEN day_count-background_day_count ELSE 0 END AS today_interactive,
 minute,minute_count,background_minute_count,next_allowed_at
FROM work_budget;
