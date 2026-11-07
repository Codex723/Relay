import fs from "node:fs";
import path from "node:path";
import { createPool } from "./pool";

const migrationsDir = path.resolve(__dirname, "../db/migrations");

function listMigrations(): string[] {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

const read = (name: string, file: "up.sql" | "down.sql") =>
  fs.readFileSync(path.join(migrationsDir, name, file), "utf8");

async function main() {
  const cmd = process.argv[2] ?? "status";
  const target = process.argv[3];
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const applied = (await client.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name")).rows.map(
      (r) => r.name,
    );

    if (cmd === "up") {
      const pending = listMigrations().filter((m) => !applied.includes(m));
      if (pending.length === 0) console.log("Nothing to apply.");
      for (const name of pending) {
        await client.query("BEGIN");
        try {
          await client.query(read(name, "up.sql"));
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
          await client.query("COMMIT");
          console.log(`applied   ${name}`);
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
    } else if (cmd === "down") {
      // `down` rolls back the latest migration; `down all` rolls back everything.
      const toRevert = target === "all" ? [...applied].reverse() : applied.slice(-1);
      if (toRevert.length === 0) console.log("Nothing to roll back.");
      for (const name of toRevert) {
        await client.query("BEGIN");
        try {
          await client.query(read(name, "down.sql"));
          await client.query("DELETE FROM schema_migrations WHERE name = $1", [name]);
          await client.query("COMMIT");
          console.log(`rolled back ${name}`);
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
    } else if (cmd === "status") {
      for (const name of listMigrations()) {
        console.log(`${applied.includes(name) ? "applied" : "pending"}  ${name}`);
      }
    } else {
      throw new Error(`Unknown command "${cmd}". Use: up | down [all] | status`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
