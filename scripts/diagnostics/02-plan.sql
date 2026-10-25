-- Run only after schema/index verification. No data aggregation yet.
EXPLAIN QUERY PLAN SELECT is_default,status,last_error,failure_count,COUNT(*)
FROM product_price_summary GROUP BY is_default,status,last_error,failure_count;
EXPLAIN QUERY PLAN SELECT c.category,COUNT(r.source) FROM default_warm_category c
LEFT JOIN default_warm_ref r ON r.category=c.category GROUP BY c.category;
