import { z } from "zod";

export const Role = z.enum(["CUSTOMER", "RIDER", "ADMIN"]);
export type Role = z.infer<typeof Role>;

export const City = z.enum(["ABUJA", "LAGOS"]);
export type City = z.infer<typeof City>;

export const OrderStatus = z.enum([
  "PENDING_PAYMENT",
  "PAID",
  "SEARCHING_RIDER",
  "ASSIGNED",
  "PICKED_UP",
  "DELIVERED",
  "CANCELLED",
  "PAYMENT_REVIEW",
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const HealthResponse = z.object({
  ok: z.literal(true),
  service: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// ---- Auth ----
export const RegisterInput = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  // bcrypt only uses the first 72 bytes, so cap the length instead of silently truncating.
  password: z.string().min(10).max(72),
  phone: z.string().trim().min(7).max(20).optional(),
  // Admin accounts are never created through the API.
  role: z.enum(["CUSTOMER", "RIDER"]).default("CUSTOMER"),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(72),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const PublicUser = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  phone: z.string().nullable(),
  role: Role,
});
export type PublicUser = z.infer<typeof PublicUser>;

export const AuthResponse = z.object({
  user: PublicUser,
  accessToken: z.string(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiError>;

// ---- Vendors, items, orders ----
export const VendorSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  city: City,
  address: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  isOpen: z.boolean(),
});
export type VendorSummary = z.infer<typeof VendorSummary>;

export const ItemSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  priceKobo: z.number().int(),
  imageUrl: z.string().nullable(),
  isAvailable: z.boolean(),
});
export type ItemSummary = z.infer<typeof ItemSummary>;

// Note: there is deliberately no price field. Prices and totals are always computed on the server.
export const CreateOrderInput = z.object({
  vendorId: z.string().uuid(),
  items: z
    .array(z.object({ itemId: z.string().uuid(), quantity: z.number().int().min(1).max(20) }))
    .min(1)
    .max(30),
  dropAddress: z.string().trim().min(5).max(200),
  dropLat: z.number().min(-90).max(90),
  dropLng: z.number().min(-180).max(180),
});
export type CreateOrderInput = z.infer<typeof CreateOrderInput>;

export const OrderLineView = z.object({
  itemId: z.string().uuid(),
  name: z.string(),
  quantity: z.number().int(),
  unitPriceKobo: z.number().int(),
});
export type OrderLineView = z.infer<typeof OrderLineView>;

export const QuoteView = z.object({
  vendorId: z.string().uuid(),
  lines: z.array(OrderLineView),
  subtotalKobo: z.number().int(),
  deliveryFeeKobo: z.number().int(),
  totalKobo: z.number().int(),
  distanceM: z.number().int(),
});
export type QuoteView = z.infer<typeof QuoteView>;

export const OrderView = QuoteView.extend({
  id: z.string().uuid(),
  status: OrderStatus,
  dropAddress: z.string(),
  dropLat: z.number(),
  dropLng: z.number(),
  vendorName: z.string(),
  vendorLat: z.number(),
  vendorLng: z.number(),
  createdAt: z.string(),
});
export type OrderView = z.infer<typeof OrderView>;

// ---- Payments ----
export const PaymentInit = z.object({
  authorizationUrl: z.string().url(),
  reference: z.string(),
});
export type PaymentInit = z.infer<typeof PaymentInit>;

// ---- Rider ----
export const LocationInput = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LocationInput = z.infer<typeof LocationInput>;

// Riders can only move an order forward to these two states. Everything else is done by the system or an admin.
export const RiderOrderStatusInput = z.object({ status: z.enum(["PICKED_UP", "DELIVERED"]) });
export type RiderOrderStatusInput = z.infer<typeof RiderOrderStatusInput>;

export const RiderOrderView = z.object({
  id: z.string().uuid(),
  status: OrderStatus,
  vendorName: z.string(),
  vendorAddress: z.string().nullable(),
  vendorLat: z.number(),
  vendorLng: z.number(),
  dropAddress: z.string(),
  dropLat: z.number(),
  dropLng: z.number(),
  distanceM: z.number().int(),
  deliveryFeeKobo: z.number().int(),
  items: z.array(z.object({ name: z.string(), quantity: z.number().int() })),
});
export type RiderOrderView = z.infer<typeof RiderOrderView>;

export const RiderOfferView = z.object({
  offerId: z.string().uuid(),
  expiresAt: z.string(),
  order: RiderOrderView,
});
export type RiderOfferView = z.infer<typeof RiderOfferView>;
