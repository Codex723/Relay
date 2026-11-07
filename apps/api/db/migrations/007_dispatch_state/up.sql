-- Dispatch bookkeeping on the order: how many rounds have failed, when to try again, and when an admin was alerted.
ALTER TABLE orders
  ADD COLUMN dispatch_attempts   integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  ADD COLUMN dispatch_next_at    timestamptz,
  ADD COLUMN dispatch_alerted_at timestamptz;

-- Orders the dispatcher should look at on each tick.
CREATE INDEX orders_dispatch_due_idx
  ON orders (dispatch_next_at)
  WHERE status = 'SEARCHING_RIDER' AND dispatch_alerted_at IS NULL;

-- Offers waiting to expire.
CREATE INDEX offers_pending_expiry_idx
  ON dispatch_offers (expires_at)
  WHERE status = 'PENDING';
