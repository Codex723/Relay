import jwt from "jsonwebtoken";
import type { Role } from "@relay/shared";
import type { Config } from "../config";

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface TokenSubject {
  id: string;
  role: Role;
}

export function signAccessToken(user: TokenSubject, config: Config): string {
  return jwt.sign({ role: user.role, typ: "access" }, config.JWT_SECRET, {
    subject: user.id,
    expiresIn: ACCESS_TTL_SECONDS,
    algorithm: "HS256",
  });
}

export function signRefreshToken(user: TokenSubject, config: Config): string {
  return jwt.sign({ typ: "refresh" }, config.JWT_REFRESH_SECRET, {
    subject: user.id,
    expiresIn: REFRESH_TTL_SECONDS,
    algorithm: "HS256",
  });
}

export interface AccessClaims {
  userId: string;
  role: Role;
}

export function verifyAccessToken(token: string, config: Config): AccessClaims | null {
  try {
    const p = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof p === "string" || p.typ !== "access" || typeof p.sub !== "string") return null;
    if (p.role !== "CUSTOMER" && p.role !== "RIDER" && p.role !== "ADMIN") return null;
    return { userId: p.sub, role: p.role };
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string, config: Config): string | null {
  try {
    const p = jwt.verify(token, config.JWT_REFRESH_SECRET, { algorithms: ["HS256"] });
    if (typeof p === "string" || p.typ !== "refresh" || typeof p.sub !== "string") return null;
    return p.sub;
  } catch {
    return null;
  }
}
