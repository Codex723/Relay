import "./env";
import { createServer } from "node:http";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { createDispatcher } from "./dispatch/dispatcher";
import { createPaystackClient } from "./payments/paystack";
import { createRealtime } from "./realtime/realtime";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const realtime = createRealtime({ db, config });
const dispatcher = createDispatcher({
  db,
  config,
  onOffer: (offer) => realtime.offerCreated(offer),
  onAdminAlert: (alert) => {
    console.warn("dispatch alert: order needs an admin", alert);
    realtime.adminAlert(alert);
  },
});
const app = createApp({
  db,
  config,
  paystack: createPaystackClient(config),
  dispatcher,
  realtime,
  // After payment: tell connected clients, then offer to a rider straight away instead of waiting for a tick.
  onOrderPaid: (orderId) => {
    realtime.orderChanged(orderId);
    if (config.DISPATCH_ENABLED) dispatcher.dispatchOrder(orderId).catch((err) => console.error("dispatch failed", err));
  },
});

const server = createServer(app);
realtime.attach(server);
if (config.DISPATCH_ENABLED) dispatcher.start();
else console.warn("Dispatcher is disabled (DISPATCH_ENABLED=false). Orders will wait for a manual assignment.");

server.listen(config.PORT, () => {
  console.log(`RELAY API listening on http://localhost:${config.PORT}`);
});

const shutdown = () => {
  dispatcher.stop();
  // Closing the socket server also closes the HTTP server underneath it.
  void realtime.close().finally(() => void db.destroy().finally(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
