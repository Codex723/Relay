import type { ColumnType, Generated } from "kysely";

// Hand-written to match apps/api/db/migrations. Update both together.
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
// pg returns numeric columns as strings to avoid precision loss.
type Numeric = ColumnType<string, number | string, number | string>;

export type UserRole = "CUSTOMER" | "RIDER" | "ADMIN";
export type CityName = "ABUJA" | "LAGOS";
export type OrderStatusName =
  | "PENDING_PAYMENT"
  | "PAID"
  | "SEARCHING_RIDER"
  | "ASSIGNED"
  | "PICKED_UP"
  | "DELIVERED"
  | "CANCELLED"
  | "PAYMENT_REVIEW";
export type OfferStatusName = "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED";

export interface UsersTable {
  id: Generated<string>;
  name: string;
  email: string;
  phone: string | null;
  password_hash: string;
  role: UserRole;
  created_at: Generated<Date>;
}

export interface VendorsTable {
  id: Generated<string>;
  name: string;
  city: CityName;
  address: string | null;
  lat: Numeric;
  lng: Numeric;
  is_open: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface ItemsTable {
  id: Generated<string>;
  vendor_id: string;
  name: string;
  description: string | null;
  price_kobo: number;
  image_url: string | null;
  is_available: Generated<boolean>;
}

export interface OrdersTable {
  id: Generated<string>;
  customer_id: string;
  vendor_id: string;
  rider_id: string | null;
  status: Generated<OrderStatusName>;
  subtotal_kobo: number;
  delivery_fee_kobo: number;
  total_kobo: number;
  drop_address: string;
  drop_lat: Numeric;
  drop_lng: Numeric;
  distance_m: number;
  paystack_reference: string | null;
  dispatch_attempts: Generated<number>;
  dispatch_next_at: Date | null;
  dispatch_alerted_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrderItemsTable {
  id: Generated<string>;
  order_id: string;
  item_id: string;
  quantity: number;
  unit_price_kobo: number;
}

export interface RidersTable {
  user_id: string;
  is_online: Generated<boolean>;
  current_lat: Numeric | null;
  current_lng: Numeric | null;
  last_seen_at: Timestamp | null;
  vehicle_type: string | null;
}

export interface DispatchOffersTable {
  id: Generated<string>;
  order_id: string;
  rider_id: string;
  status: Generated<OfferStatusName>;
  offered_at: Generated<Date>;
  expires_at: Timestamp;
}

export interface PaymentsTable {
  id: Generated<string>;
  order_id: string;
  reference: string;
  amount_kobo: number;
  status: string;
  raw_webhook: unknown | null;
  paid_at: Timestamp | null;
}

export interface OrderEventsTable {
  id: Generated<string>;
  order_id: string;
  from_status: OrderStatusName | null;
  to_status: OrderStatusName;
  actor_id: string | null;
  created_at: Generated<Date>;
}

export interface DB {
  users: UsersTable;
  vendors: VendorsTable;
  items: ItemsTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  riders: RidersTable;
  dispatch_offers: DispatchOffersTable;
  payments: PaymentsTable;
  order_events: OrderEventsTable;
}
