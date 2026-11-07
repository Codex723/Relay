DROP INDEX offers_pending_expiry_idx;
DROP INDEX orders_dispatch_due_idx;
ALTER TABLE orders
  DROP COLUMN dispatch_alerted_at,
  DROP COLUMN dispatch_next_at,
  DROP COLUMN dispatch_attempts;
