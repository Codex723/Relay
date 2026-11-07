CREATE TYPE offer_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

CREATE TABLE riders (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_online    boolean NOT NULL DEFAULT false,
  current_lat  numeric(9,6),
  current_lng  numeric(9,6),
  last_seen_at timestamptz,
  vehicle_type text
);

CREATE TABLE dispatch_offers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  rider_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status     offer_status NOT NULL DEFAULT 'PENDING',
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > offered_at)
);

-- A rider can hold only one active order at a time.
CREATE UNIQUE INDEX orders_one_active_per_rider
  ON orders (rider_id)
  WHERE rider_id IS NOT NULL AND status IN ('ASSIGNED', 'PICKED_UP');
