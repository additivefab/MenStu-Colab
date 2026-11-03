// Step 1: make sure the LOCAL D1 under .wrangler/state is migrated, has the
// local superadmin and the synthetic research-loop seed. Missing pieces are
// created with the repository's own scripts (db:migrate:local, dev:admin,
// seed-research-loop.mjs); nothing here touches a hosted database.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Miniflare } from "miniflare";

import { ROOT, STUDENT_ID } from "./constants.mjs";
import { readCredentials } from "./platform-api.mjs";

const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000000";

async function inspect() {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
    compatibilityDate: "2025-09-01",
    d1Databases: { DB: LOCAL_DATABASE_ID },
    d1Persist: path.join(ROOT, ".wrangler/state/v3/d1"),
  });
  try {
    const db = await mf.getD1Database("DB");
    const has = async (sql, ...binds) => Boolean(await db.prepare(sql).bind(...binds).first());
    const migrated = await has("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'");
    if (!migrated) return { migrated: false, admin: false, seeded: false };
    return {
      migrated: true,
      admin: await has("SELECT id FROM app_users WHERE feishu_open_id = 'local-dev-only:superadmin'"),
      seeded: await has("SELECT id FROM students WHERE id = ? AND active = 1", STUDENT_ID)
        && await has("SELECT student_id FROM student_repository_bindings WHERE student_id = ? AND active = 1", STUDENT_ID),
    };
  } finally {
    await mf.dispose();
  }
}

function run(label, command, args) {
  console.log(`  → ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`);
}

export async function ensureLocalDatabase() {
  let state = await inspect();
  if (!state.migrated) run("npm run db:migrate:local", "npm", ["run", "db:migrate:local"]);
  state = await inspect();
  if (!state.admin) run("npm run dev:admin", "npm", ["run", "dev:admin"]);
  const credentials = readCredentials();
  const seededLogins = credentials.synthetic_student_password && credentials.synthetic_mentor_password;
  if (!state.seeded || !seededLogins) {
    // --reset only replaces the seed's own synthetic rows (see README-research-loop-seed.md).
    run("seed-research-loop.mjs --reset", process.execPath, ["--experimental-strip-types", "scripts/local-dev/seed-research-loop.mjs", "--reset"]);
  }
  state = await inspect();
  if (!state.migrated || !state.admin || !state.seeded) throw new Error("local database is still not migrated/seeded");
  return state;
}
