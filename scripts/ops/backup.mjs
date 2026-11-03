// Backs up D1 + R2 into a timestamped directory with a manifest (T26).
//
// Local (default): reads the dev state the dev server uses.
//   node --experimental-strip-types scripts/ops/backup.mjs [--state .wrangler/state] [--out .wrangler/backups]
//
// Production (see docs/ops/备份与恢复.md): export first with Cloudflare's tools,
// then build the same manifest-bearing backup from those files:
//   wrangler d1 export <DB_NAME> --remote --output d1.sql
//   rclone copy r2:<bucket> ./r2-objects            (or wrangler r2 object get, per key)
//   node --experimental-strip-types scripts/ops/backup.mjs --d1-sql d1.sql --r2-dir ./r2-objects --out <encrypted volume>
//
// Never reads Worker secrets; refuses to write rows that look like live
// credentials unless --allow-secret-findings. Prints only counts and paths.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBackup, importR2Tree, loadSqlDump } from "./backup-core.mjs";
import { DEFAULT_STATE, ROOT, openLocalState, parseArgs } from "./local-state.mjs";

const USAGE = `Usage:
  backup.mjs [--state <dir>] [--out <dir>] [--allow-secret-findings]
  backup.mjs --d1-sql <wrangler-export.sql> [--r2-dir <dir>] [--out <dir>] [--label <text>]`;

async function main() {
  const options = parseArgs(process.argv.slice(2), { flags: ["state", "out", "d1-sql", "r2-dir", "label"], switches: ["allow-secret-findings", "help"] });
  if (options.help) { console.log(USAGE); return; }
  const outDir = path.resolve(options.out ?? path.join(ROOT, ".wrangler/backups"));
  let scratch = null;
  let stateDir = path.resolve(options.state ?? DEFAULT_STATE);
  let source = { kind: "local-state", state: path.relative(ROOT, stateDir) || stateDir };
  if (options["d1-sql"]) {
    // Production path: load the wrangler export into a throwaway local state.
    scratch = await mkdtemp(path.join(tmpdir(), "tanyan-backup-"));
    stateDir = scratch;
    source = { kind: "wrangler-export", d1Sql: path.basename(options["d1-sql"]), r2Dir: options["r2-dir"] ? path.basename(options["r2-dir"]) : null, label: options.label ?? null };
  } else if (options["r2-dir"]) {
    throw new Error("--r2-dir is only used together with --d1-sql");
  }
  const { mf, db, bucket } = await openLocalState(stateDir);
  try {
    if (options["d1-sql"]) {
      const loaded = await loadSqlDump(db, await readFile(path.resolve(options["d1-sql"]), "utf8"));
      console.log(`loaded ${loaded.tables} table(s), ${loaded.rows} row(s) from ${options["d1-sql"]}`);
    }
    if (options["r2-dir"]) console.log(`imported ${await importR2Tree(bucket, options["r2-dir"])} R2 object(s) from ${options["r2-dir"]}`);
    const { dir, manifest } = await createBackup({
      db, bucket, outDir, source, allowSecretFindings: Boolean(options["allow-secret-findings"]), log: (line) => console.log(line),
    });
    console.log(`\nBackup written: ${dir}`);
    console.log(`schema v${manifest.schema.appSchemaVersion ?? "?"} · ${Object.keys(manifest.d1.tables).length} tables · ${manifest.d1.totalRows} rows · `
      + `${manifest.r2.objects.length} R2 objects (${manifest.r2.referencedByDatabase} referenced by rows)`);
    const preflight = manifest.sourcePreflight;
    if (preflight.missingObjects.length || preflight.mismatchedObjects.length) {
      console.warn(`WARNING: the SOURCE already had ${preflight.missingObjects.length} missing and ${preflight.mismatchedObjects.length} mismatched referenced object(s); see manifest.sourcePreflight.`);
    }
    if (manifest.secrets.secretScanFindings.length) console.warn(`WARNING: ${manifest.secrets.secretScanFindings.length} secret-scan finding(s) were allowed into this backup.`);
    console.log("Store this directory encrypted, apart from the Worker secrets. It contains password and token hashes.");
  } finally {
    await mf.dispose();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  console.error(USAGE);
  process.exitCode = 1;
});
