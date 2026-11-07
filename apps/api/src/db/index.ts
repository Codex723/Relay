import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { DB } from "./types";

export type Database = Kysely<DB>;

export function createDb(connectionString: string): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 10 }) }) });
}
