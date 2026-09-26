-- Additive upgrade: retain all prices, timestamps, leases and existing budget counts.
ALTER TABLE product_price_summary ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1));
ALTER TABLE product_price_summary ADD COLUMN queue_lane TEXT NOT NULL DEFAULT 'background' CHECK (queue_lane IN ('interactive','background'));
CREATE INDEX price_default_due ON product_price_summary(provider,is_default,next_refresh_at);
DROP INDEX price_refresh_due;
CREATE INDEX price_refresh_due ON product_price_summary(provider,is_default,priority,next_refresh_at);
ALTER TABLE work_budget ADD COLUMN background_day_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_budget ADD COLUMN background_minute_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE default_warm_category (
  category TEXT PRIMARY KEY,
  next_sync_at INTEGER NOT NULL DEFAULT 0,
  token TEXT
) WITHOUT ROWID;
CREATE INDEX default_category_due ON default_warm_category(next_sync_at);
CREATE TABLE default_warm_ref (
  category TEXT NOT NULL,
  source TEXT NOT NULL,
  upstream_key TEXT NOT NULL,
  PRIMARY KEY(category,source,upstream_key)
) WITHOUT ROWID;
CREATE INDEX default_ref_identity ON default_warm_ref(source,upstream_key);
-- Reuse the fixed-size budget clock for category-list sync admission, not Yahoo work.
INSERT INTO work_budget(name) VALUES ('default_sync');
