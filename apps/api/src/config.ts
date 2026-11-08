import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
    // Server-side Paystack secret. Outside production only test keys (sk_test_...) are accepted.
    PAYSTACK_SECRET_KEY: z.string().min(1, "PAYSTACK_SECRET_KEY is required"),
    // Dispatcher. An offer lasts OFFER_SECONDS; after MAX_ROUNDS failed rounds an admin is alerted.
    DISPATCH_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    DISPATCH_OFFER_SECONDS: z.coerce.number().int().positive().default(30),
    DISPATCH_TICK_MS: z.coerce.number().int().positive().default(2000),
    DISPATCH_RETRY_SECONDS: z.coerce.number().int().positive().default(20),
    DISPATCH_MAX_ROUNDS: z.coerce.number().int().positive().default(3),
    DISPATCH_MAX_PICKUP_KM: z.coerce.number().positive().default(15),
    DISPATCH_RIDER_STALE_SECONDS: z.coerce.number().int().positive().default(120),
    // Minimum time between live location broadcasts for one rider.
    REALTIME_LOCATION_THROTTLE_MS: z.coerce.number().int().min(0).default(3000),
    // Delivery fee = max(MIN, BASE + PER_KM * km), in kobo. Defaults: 500 + 150 per km, minimum 800 naira.
    DELIVERY_BASE_FEE_KOBO: z.coerce.number().int().min(0).default(50000),
    DELIVERY_PER_KM_KOBO: z.coerce.number().int().min(0).default(15000),
    DELIVERY_MIN_FEE_KOBO: z.coerce.number().int().min(0).default(80000),
  })
  .refine((c) => c.NODE_ENV === "production" || c.PAYSTACK_SECRET_KEY.startsWith("sk_test_"), {
    message: "Outside production, PAYSTACK_SECRET_KEY must be a test key starting with sk_test_",
    path: ["PAYSTACK_SECRET_KEY"],
  })
  .refine((c) => c.JWT_SECRET !== c.JWT_REFRESH_SECRET, {
    message: "JWT_SECRET and JWT_REFRESH_SECRET must be different",
    path: ["JWT_REFRESH_SECRET"],
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${problems}. Generate secrets with: openssl rand -hex 32`);
  }
  return parsed.data;
}
