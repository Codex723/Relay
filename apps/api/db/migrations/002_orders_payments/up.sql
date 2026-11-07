CREATE TYPE order_status AS ENUM (
  'PENDING_PAYMENT', 'PAID', 'SEARCHING_RIDER', 'ASSIGNED',
  'PICKED_UP', 'DELIVERED', 'CANCELLED', 'PAYMENT_REVIEW'
);

CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  vendor_id          uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  rider_id           uuid REFERENCES users(id) ON DELETE RESTRICT,
  status             order_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  subtotal_kobo      integer NOT NULL CHECK (subtotal_kobo >= 0),
  delivery_fee_kobo  integer NOT NULL CHECK (delivery_fee_kobo >= 0),
  total_kobo         integer NOT NULL CHECK (total_kobo >= 0),
  drop_address       text NOT NULL,
  drop_lat           numeric(9,6) NOT NULL,
  drop_lng           numeric(9,6) NOT NULL,
  distance_m         integer NOT NULL CHECK (distance_m >= 0),
  paystack_reference text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (total_kobo = subtotal_kobo + delivery_fee_kobo)
);

CREATE TABLE order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id         uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  quantity        integer NOT NULL CHECK (quantity > 0),
  unit_price_kobo integer NOT NULL CHECK (unit_price_kobo >= 0)
);

CREATE TABLE payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  reference   text NOT NULL UNIQUE,
  amount_kobo integer NOT NULL CHECK (amount_kobo >= 0),
  status      text NOT NULL,
  raw_webhook jsonb,
  paid_at     timestamptz
);
