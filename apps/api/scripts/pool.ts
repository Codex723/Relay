import "../src/env";
import { Pool } from "pg";

export function createPool(): Pool {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL (or DIRECT_URL) is not set. Copy .env.example to .env first.");
  }
  return new Pool({ connectionString: url });
}
