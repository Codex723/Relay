import bcrypt from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireAuth, requireRole } from "../auth/middleware";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { createDb } from "../db";
import { createFakePaystack } from "./fakePaystack";

const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "" });
const db = createDb(config.DATABASE_URL);
const app = createApp({ db, config, paystack: createFakePaystack().client }, (a) => {
  // Test-only routes that exercise the role guard.
  a.get("/test/admin-only", requireAuth(config), requireRole("ADMIN"), (_req, res) => void res.json({ ok: true }));
  a.get("/test/rider-or-admin", requireAuth(config), requireRole("RIDER", "ADMIN"), (_req, res) => void res.json({ ok: true }));
});

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const email = (label: string) => `test-${label}-${run}@relay.test`;
const PASSWORD = "a-long-test-password";
const created: string[] = [];

const register = (label: string, extra: Record<string, unknown> = {}) => {
  created.push(email(label));
  return request(app)
    .post("/auth/register")
    .send({ name: `Test ${label}`, email: email(label), password: PASSWORD, ...extra });
};

beforeAll(async () => {
  // The database must be migrated before running tests.
  await db.selectFrom("users").select("id").limit(1).execute();
});

afterAll(async () => {
  if (created.length > 0) await db.deleteFrom("users").where("email", "in", created).execute();
  await db.destroy();
});

describe("register", () => {
  it("creates a customer, returns an access token and sets a refresh cookie, and never leaks the hash", async () => {
    const res = await register("customer");
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: email("customer"), role: "CUSTOMER" });
    expect(typeof res.body.accessToken).toBe("string");
    expect(JSON.stringify(res.body)).not.toContain("password");
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toContain("relay_refresh=");
    expect(cookie).toContain("HttpOnly");
  });

  it("creates a rider together with its riders row", async () => {
    const res = await register("rider", { role: "RIDER" });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("RIDER");
    const row = await db.selectFrom("riders").select("user_id").where("user_id", "=", res.body.user.id).executeTakeFirst();
    expect(row).toBeDefined();
  });

  it("rejects an attempt to register as ADMIN", async () => {
    const res = await register("sneaky", { role: "ADMIN" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a duplicate email with 409", async () => {
    await register("dupe");
    const res = await register("dupe");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("validates input (bad email, short password)", async () => {
    const bad = await request(app).post("/auth/register").send({ name: "X", email: "nope", password: "short" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("login", () => {
  it("logs in with correct credentials", async () => {
    await register("login");
    const res = await request(app).post("/auth/login").send({ email: email("login"), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email("login"));
  });

  it("returns the same generic 401 for a wrong password and an unknown email", async () => {
    const wrong = await request(app).post("/auth/login").send({ email: email("login"), password: "wrong-password-1" });
    const unknown = await request(app).post("/auth/login").send({ email: email("nobody"), password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
  });
});

describe("tokens and /auth/me", () => {
  it("returns the current user for a valid token", async () => {
    const reg = await register("me");
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${reg.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email("me"));
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 for a tampered token", async () => {
    const reg = await register("tamper");
    const token: string = reg.body.accessToken;
    const i = token.lastIndexOf(".") + 10;
    const tampered = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${tampered}`);
    expect(res.status).toBe(401);
  });

  it("does not accept a refresh token as an access token", async () => {
    const agent = request.agent(app);
    await agent.post("/auth/register").send({ name: "T", email: email("swap"), password: PASSWORD });
    created.push(email("swap"));
    const setCookie = (await agent.post("/auth/login").send({ email: email("swap"), password: PASSWORD })).headers["set-cookie"];
    const refreshToken = String(setCookie).match(/relay_refresh=([^;]+)/)![1];
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${refreshToken}`);
    expect(res.status).toBe(401);
  });
});

describe("refresh and logout", () => {
  it("issues a new access token from the refresh cookie", async () => {
    const agent = request.agent(app);
    created.push(email("refresh"));
    await agent.post("/auth/register").send({ name: "R", email: email("refresh"), password: PASSWORD });
    const res = await agent.post("/auth/refresh");
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe("string");
  });

  it("rejects refresh without a cookie", async () => {
    const res = await request(app).post("/auth/refresh");
    expect(res.status).toBe(401);
  });

  it("rejects an access token placed in the refresh cookie", async () => {
    const reg = await register("wrongcookie");
    const res = await request(app).post("/auth/refresh").set("Cookie", `relay_refresh=${reg.body.accessToken}`);
    expect(res.status).toBe(401);
  });

  it("logout clears the cookie so refresh fails afterwards", async () => {
    const agent = request.agent(app);
    created.push(email("logout"));
    await agent.post("/auth/register").send({ name: "L", email: email("logout"), password: PASSWORD });
    expect((await agent.post("/auth/logout")).status).toBe(204);
    expect((await agent.post("/auth/refresh")).status).toBe(401);
  });
});

describe("role guard", () => {
  it("lets an admin in and blocks customers and riders with 403", async () => {
    created.push(email("admin"));
    await db
      .insertInto("users")
      .values({
        name: "Test admin",
        email: email("admin"),
        phone: null,
        password_hash: await bcrypt.hash(PASSWORD, 4),
        role: "ADMIN",
      })
      .execute();
    const admin = await request(app).post("/auth/login").send({ email: email("admin"), password: PASSWORD });
    const customer = await register("rg-customer");
    const rider = await register("rg-rider", { role: "RIDER" });

    const asAdmin = await request(app).get("/test/admin-only").set("Authorization", `Bearer ${admin.body.accessToken}`);
    const asCustomer = await request(app).get("/test/admin-only").set("Authorization", `Bearer ${customer.body.accessToken}`);
    const asRider = await request(app).get("/test/admin-only").set("Authorization", `Bearer ${rider.body.accessToken}`);
    const anon = await request(app).get("/test/admin-only");

    expect(asAdmin.status).toBe(200);
    expect(asCustomer.status).toBe(403);
    expect(asRider.status).toBe(403);
    expect(anon.status).toBe(401);

    const riderRoute = await request(app).get("/test/rider-or-admin").set("Authorization", `Bearer ${rider.body.accessToken}`);
    const customerOnRiderRoute = await request(app).get("/test/rider-or-admin").set("Authorization", `Bearer ${customer.body.accessToken}`);
    expect(riderRoute.status).toBe(200);
    expect(customerOnRiderRoute.status).toBe(403);
  });
});

describe("misc hardening", () => {
  it("returns JSON 404 for unknown routes and sets security headers", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("returns 400 for malformed JSON instead of a stack trace", async () => {
    const res = await request(app).post("/auth/login").set("Content-Type", "application/json").send("{bad json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });
});
