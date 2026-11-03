import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { applyD1Migrations } from "./database-fixture.mjs";

const LOOP_TABLES = [
  "research_tasks", "research_task_versions", "research_task_events", "github_installations", "repository_links",
  "github_webhook_deliveries", "lab_runners", "agent_credential_profiles", "agent_attempts", "agent_attempt_events",
  "change_requests", "registered_entrypoints", "dataset_versions", "dataset_grants", "run_specs", "run_approvals",
  "runs", "run_events", "run_artifacts", "run_results", "result_reviews", "result_comments",
];

// Schema 26 tables are migration-owned: a version-25 database without 0026
// must stop at readiness, keep version 25, and recover once 0026 is applied.
test("research loop tables require migration 0026 before the runtime upgrades to schema 26", { timeout: 120_000 }, async () => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "research-loop-schema" }, r2Buckets: ["FILES"],
    outboundService: () => new Response("No external services in this test", { status: 502 }),
  });
  try {
    const db = await applyD1Migrations(mf, { before: "0026_" });
    await mf.dispatchFetch("http://localhost/api/health/ready");
    const failed = await mf.dispatchFetch("http://localhost/api/health/ready");
    assert.equal(failed.status, 503);
    const version = (await db.prepare("SELECT version FROM app_schema_meta WHERE id=1").first())?.version;
    assert.notEqual(version, 26, "a missing 0026 migration must not advance the runtime version");
    const placeholders = LOOP_TABLES.map(() => "?").join(",");
    const created = await db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).bind(...LOOP_TABLES).first();
    assert.equal(created.n, 0, "requests cannot create migration-owned research loop tables");

    await applyD1Migrations(mf, { from: "0026_" });
    const recovered = await (await mf.dispatchFetch("http://localhost/api/health/ready")).json();
    assert.equal(recovered.checks.find((check) => check.id === "schema")?.status, "pass", JSON.stringify(recovered));
    assert.equal((await db.prepare("SELECT version FROM app_schema_meta WHERE id=1").first()).version, 26);
    assert.equal((await db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).bind(...LOOP_TABLES).first()).n, LOOP_TABLES.length);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally { await mf.dispose(); }
});
