-- now() is the transaction start time, so events written in one transaction (for example PAID then
-- SEARCHING_RIDER) would share a timestamp and could not be ordered. clock_timestamp() is the actual
-- time of each insert.
ALTER TABLE order_events ALTER COLUMN created_at SET DEFAULT clock_timestamp();
