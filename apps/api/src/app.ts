import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { HealthResponse } from "@relay/shared";
import { authRouter } from "./auth/routes";
import { LIVE_PAGE } from "./dev/livePage";
import type { Config } from "./config";
import type { Database } from "./db";
import { errorHandler, sendError } from "./http";
import type { Dispatcher } from "./dispatch/dispatcher";
import { ordersRouter } from "./orders/routes";
import { paymentsRouter } from "./payments/routes";
import type { PaystackClient } from "./payments/paystack";
import { noopRealtime, type Realtime } from "./realtime/realtime";
import { riderRouter } from "./rider/routes";
import { vendorsRouter } from "./vendors/routes";

export interface AppDeps {
  db: Database;
  config: Config;
  paystack: PaystackClient;
  dispatcher: Dispatcher;
  /** Live push to connected clients. Optional: without it nothing is pushed. */
  realtime?: Realtime;
  /** Called after an order has been paid and is ready for a rider. */
  onOrderPaid?: (orderId: string) => void;
}

// `extend` lets tests (and later steps) mount extra routes before the 404 and error handlers.
export function createApp({ db, config, paystack, dispatcher, realtime = noopRealtime, onOrderPaid }: AppDeps, extend?: (app: Express) => void): Express {
  const app = express();
  if (config.NODE_ENV === "production") app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
  // Payments must come before the JSON parser: the webhook signature is checked against the raw body.
  app.use("/payments", paymentsRouter(db, config, paystack, onOrderPaid));

  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    const body: HealthResponse = { ok: true, service: "relay-api", time: new Date().toISOString() };
    res.json(body);
  });

  // Development-only page for watching the live feed. It needs inline scripts, so it gets its own CSP.
  if (config.NODE_ENV !== "production") {
    app.get("/dev/live", (_req, res) => {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:",
      );
      res.type("html").send(LIVE_PAGE);
    });
  }

  app.use("/auth", authRouter(db, config));
  app.use("/vendors", vendorsRouter(db));
  app.use("/orders", ordersRouter(db, config, paystack, realtime));
  app.use("/rider", riderRouter(db, config, dispatcher, realtime));
  extend?.(app);

  app.use((_req, res) => void sendError(res, 404, "NOT_FOUND", "Route not found."));
  app.use(errorHandler);
  return app;
}
