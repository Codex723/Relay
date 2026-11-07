import bcrypt from "bcryptjs";
import { Router, type CookieOptions, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { LoginInput, RegisterInput, type AuthResponse, type PublicUser } from "@relay/shared";
import type { Config } from "../config";
import type { Database } from "../db";
import { HttpError, asyncHandler, sendError } from "../http";
import { requireAuth } from "./middleware";
import {
  REFRESH_TTL_SECONDS,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "./tokens";

const REFRESH_COOKIE = "relay_refresh";
const BCRYPT_ROUNDS = 12;
// Compared against when an email is unknown so login timing does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("relay-dummy-password", BCRYPT_ROUNDS);

const USER_COLUMNS = ["id", "name", "email", "phone", "role"] as const;

function refreshCookieOptions(config: Config): CookieOptions {
  const prod = config.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: prod,
    // The web app (Vercel) and API (Render) are on different sites in production.
    sameSite: prod ? "none" : "lax",
    path: "/auth",
    maxAge: REFRESH_TTL_SECONDS * 1000,
  };
}

function issueSession(res: Response, user: PublicUser, config: Config): AuthResponse {
  res.cookie(REFRESH_COOKIE, signRefreshToken(user, config), refreshCookieOptions(config));
  return { user, accessToken: signAccessToken(user, config) };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export function authRouter(db: Database, config: Config): Router {
  const router = Router();

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => config.NODE_ENV === "test",
    handler: (_req, res) => void sendError(res, 429, "RATE_LIMITED", "Too many attempts. Try again later."),
  });

  router.post(
    "/register",
    limiter,
    asyncHandler(async (req, res) => {
      const input = RegisterInput.parse(req.body);
      const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
      try {
        const user = await db.transaction().execute(async (trx) => {
          const created = await trx
            .insertInto("users")
            .values({
              name: input.name,
              email: input.email,
              phone: input.phone ?? null,
              password_hash: passwordHash,
              role: input.role,
            })
            .returning(USER_COLUMNS)
            .executeTakeFirstOrThrow();
          if (input.role === "RIDER") {
            await trx.insertInto("riders").values({ user_id: created.id }).execute();
          }
          return created;
        });
        res.status(201).json(issueSession(res, user, config));
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists.");
        throw err;
      }
    }),
  );

  router.post(
    "/login",
    limiter,
    asyncHandler(async (req, res) => {
      const input = LoginInput.parse(req.body);
      const row = await db
        .selectFrom("users")
        .select([...USER_COLUMNS, "password_hash"])
        .where("email", "=", input.email)
        .executeTakeFirst();
      const ok = await bcrypt.compare(input.password, row?.password_hash ?? DUMMY_HASH);
      if (!row || !ok) throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
      const user: PublicUser = { id: row.id, name: row.name, email: row.email, phone: row.phone, role: row.role };
      res.json(issueSession(res, user, config));
    }),
  );

  router.post(
    "/refresh",
    limiter,
    asyncHandler(async (req, res) => {
      const token = req.cookies?.[REFRESH_COOKIE];
      const userId = typeof token === "string" ? verifyRefreshToken(token, config) : null;
      if (!userId) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
      const user = await db.selectFrom("users").select(USER_COLUMNS).where("id", "=", userId).executeTakeFirst();
      if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
      res.json({ user, accessToken: signAccessToken(user, config) } satisfies AuthResponse);
    }),
  );

  router.post("/logout", (_req, res) => {
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(config), maxAge: undefined });
    res.status(204).end();
  });

  router.get(
    "/me",
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const user = await db
        .selectFrom("users")
        .select(USER_COLUMNS)
        .where("id", "=", req.auth!.userId)
        .executeTakeFirst();
      if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
      res.json({ user });
    }),
  );

  return router;
}
