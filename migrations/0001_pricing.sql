-- Current summaries only. No catalog numeric IDs, barcodes, credentials or offers.
CREATE TABLE product_price_summary (
  source TEXT NOT NULL,
  upstream_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('complete','empty','unsupported','pending','missing')),
  lowest_price INTEGER,
  offer_count INTEGER,
  fetched_at INTEGER,
  expires_at INTEGER,
  last_requested_at INTEGER,
  access_window_at INTEGER NOT NULL DEFAULT 0,
  access_count INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 0 AND 3),
  next_refresh_at INTEGER NOT NULL,
  retry_after INTEGER NOT NULL DEFAULT 0,
  queue_token TEXT,
  queued_until INTEGER NOT NULL DEFAULT 0,
  run_token TEXT,
  run_until INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, upstream_key, provider),
  CHECK (
    (status='complete' AND lowest_price IS NOT NULL AND lowest_price > 0 AND offer_count IS NOT NULL AND offer_count > 0 AND fetched_at IS NOT NULL AND expires_at IS NOT NULL)
    OR (status='empty' AND lowest_price IS NULL AND offer_count IS NOT NULL AND offer_count=0 AND fetched_at IS NOT NULL AND expires_at IS NOT NULL)
    OR (status IN ('unsupported','missing') AND lowest_price IS NULL AND offer_count IS NOT NULL AND offer_count=0 AND fetched_at IS NULL AND expires_at IS NOT NULL)
    OR (status='pending' AND lowest_price IS NULL AND offer_count IS NULL AND fetched_at IS NULL)
  )
) WITHOUT ROWID;
CREATE INDEX price_refresh_due ON product_price_summary(provider, priority, next_refresh_at);

-- Global, atomic admission across isolates; fixed-size rows, not request history.
CREATE TABLE work_budget (
  name TEXT PRIMARY KEY,
  day INTEGER NOT NULL DEFAULT 0,
  day_count INTEGER NOT NULL DEFAULT 0,
  minute INTEGER NOT NULL DEFAULT 0,
  minute_count INTEGER NOT NULL DEFAULT 0,
  next_allowed_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
INSERT INTO work_budget(name) VALUES ('queue'), ('yahoo');
