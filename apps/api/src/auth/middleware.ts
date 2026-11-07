import type { RequestHandler } from "express";
import type { Role } from "@relay/shared";
import type { Config } from "../config";
import { sendError } from "../http";
import { verifyAccessToken } from "./tokens";

export interface AuthContext {
  userId: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

export function requireAuth(config: Config): RequestHandler {
  return (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    const claims = scheme === "Bearer" && token ? verifyAccessToken(token, config) : null;
    if (!claims) return void sendError(res, 401, "UNAUTHENTICATED", "Sign in to continue.");
    req.auth = claims;
    next();
  };
}

// Use after requireAuth. Every role-restricted route must declare its roles explicitly.
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) return void sendError(res, 401, "UNAUTHENTICATED", "Sign in to continue.");
    if (!roles.includes(req.auth.role)) {
      return void sendError(res, 403, "FORBIDDEN", "You do not have access to this resource.");
    }
    next();
  };
}
