CREATE TYPE user_role AS ENUM ('CUSTOMER', 'RIDER', 'ADMIN');
CREATE TYPE city AS ENUM ('ABUJA', 'LAGOS');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  phone         text,
  password_hash text NOT NULL,
  role          user_role NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  city       city NOT NULL,
  address    text,
  lat        numeric(9,6) NOT NULL,
  lng        numeric(9,6) NOT NULL,
  is_open    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  description  text,
  price_kobo   integer NOT NULL CHECK (price_kobo >= 0),
  image_url    text,
  is_available boolean NOT NULL DEFAULT true
);
