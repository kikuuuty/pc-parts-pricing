-- Read-only. Inspect these results BEFORE using the other files.
SELECT datetime('now') AS observed_at_utc;
SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%';
PRAGMA table_info(product_price_summary);
PRAGMA index_list(product_price_summary);
PRAGMA table_info(work_budget);
SELECT name,applied_at FROM d1_migrations ORDER BY id;
-- Bounded cardinality probe, not a full COUNT of a potentially large table.
SELECT COUNT(*) AS summary_rows_up_to_2001 FROM (SELECT 1 FROM product_price_summary LIMIT 2001);
SELECT COUNT(*) AS membership_rows_up_to_2001 FROM (SELECT 1 FROM default_warm_ref LIMIT 2001);
