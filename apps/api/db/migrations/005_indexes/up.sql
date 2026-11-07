CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_status_created_idx   ON orders (status, created_at);
CREATE INDEX riders_online_idx           ON riders (is_online, current_lat, current_lng);
CREATE INDEX offers_order_status_idx     ON dispatch_offers (order_id, status);
CREATE INDEX offers_rider_status_idx     ON dispatch_offers (rider_id, status);
CREATE INDEX items_vendor_available_idx  ON items (vendor_id, is_available);
CREATE INDEX vendors_city_open_idx       ON vendors (city, is_open);
CREATE INDEX order_events_order_idx      ON order_events (order_id, created_at);
