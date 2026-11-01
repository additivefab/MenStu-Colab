import { readFile, readdir } from "node:fs/promises";

// Hosted Sites applies immutable Drizzle migrations before starting the Worker.
// Local HTTP fixtures follow that lifecycle instead of relying on request-time DDL.
export async function applyD1Migrations(worker, { from = "0000_", before = "9999_" } = {}) {
  const db = await worker.getD1Database("DB");
  const directory = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && name >= from && name < before)
    .sort();
  for (const name of names) {
    const sql = await readFile(new URL(name, directory), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  return db;
}
