import "./env";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { createDispatcher } from "./dispatch/dispatcher";
import { createPaystackClient } from "./payments/paystack";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const dispatcher = createDispatcher({ db, config });
const app = createApp({
  db,
  config,
  paystack: createPaystackClient(config),
  // Offer to a rider immediately after payment instead of waiting for the next dispatcher tick.
  onOrderPaid: (orderId) => {
    if (config.DISPATCH_ENABLED) dispatcher.dispatchOrder(orderId).catch((err) => console.error("dispatch failed", err));
  },
});
if (config.DISPATCH_ENABLED) dispatcher.start();
else console.warn("Dispatcher is disabled (DISPATCH_ENABLED=false). Orders will wait for a manual assignment.");

const server = app.listen(config.PORT, () => {
  console.log(`RELAY API listening on http://localhost:${config.PORT}`);
});

const shutdown = () => {
  dispatcher.stop();
  server.close(() => {
    void db.destroy().finally(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
