import { rateLimit } from "express-rate-limit";
import type { Config } from "./config";
import { sendError } from "./http";

export function makeLimiter(config: Config, windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => config.NODE_ENV === "test",
    handler: (_req, res) => void sendError(res, 429, "RATE_LIMITED", "Too many requests. Try again shortly."),
  });
}
