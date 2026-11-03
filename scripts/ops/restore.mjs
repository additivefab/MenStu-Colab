// Restores a backup into a FRESH local state, invalidates every restored
// credential, then verifies FKs, row counts, research-loop relations and R2
// objects (T26). Exit code 0 only when every check passes.
//
//   node scripts/ops/restore.mjs --backup <dir> --target-state <new dir> [--force]
//   node scripts/ops/restore.mjs --backup <dir> --target-state <dir> --verify-only
//
// Production hand-off (docs/ops/备份与恢复.md): after a passing local restore,
//   --emit-sql <dir>     writes d1-restore.sql (+ d1-sequences.sql) from the
//                        restored, already-invalidated database, for
//                        `wrangler d1 execute <NEW_DB> --remote --file`;
//   --emit-r2-dir <dir>  writes objects under their keys for `rclone copy`.
//
// The target must be empty: a non-empty target is refused unless --force,
// which WIPES it first. The default dev state is never a valid target without
// --force.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  RestoreRefusedError, emitR2Tree, emitSql, formatReport, readBackup, restoreBackup, verifyRestore,
} from "./backup-core.mjs";
import { DEFAULT_STATE, openLocalState, parseArgs } from "./local-state.mjs";

const USAGE = `Usage:
  restore.mjs --backup <dir> --target-state <dir> [--force] [--emit-sql <dir>] [--emit-r2-dir <dir>]
  restore.mjs --backup <dir> --target-state <dir> --verify-only`;

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    flags: ["backup", "target-state", "emit-sql", "emit-r2-dir"], switches: ["force", "verify-only", "help"],
  });
  if (options.help) { console.log(USAGE); return; }
  if (!options.backup || !options["target-state"]) throw new Error("--backup and --target-state are required");
  const backupDir = path.resolve(options.backup);
  const target = path.resolve(options["target-state"]);
  if (target === path.resolve(DEFAULT_STATE) && !options.force && !options["verify-only"]) {
    throw new RestoreRefusedError("Refusing to restore into the dev state .wrangler/state; restore into a new directory and swap it in after it verifies.");
  }
  const { mf, db, bucket } = await openLocalState(target);
  try {
    let verification;
    if (options["verify-only"]) {
      verification = await verifyRestore({ db, bucket, manifest: await readBackup(backupDir), backupDir, invalidated: true });
    } else {
      const result = await restoreBackup({ db, bucket, backupDir, force: Boolean(options.force), log: (line) => console.log(line) });
      verification = result.verification;
      const { invalidation } = result;
      console.log(`\nInvalidated: ${invalidation.sessionsDeleted} session(s), ${invalidation.runnersDisabled} runner token(s) (runners disabled), `
        + `${invalidation.activationsCleared} activation code(s), ${invalidation.authAttemptsCleared} rate-limit window(s).`);
      if (invalidation.unexpectedTokenColumns.length) console.warn(`WARNING: columns that may hold tokens: ${invalidation.unexpectedTokenColumns.join(", ")}`);
      const report = { backup: path.basename(backupDir), restoredAt: new Date().toISOString(), invalidation, verification };
      await writeFile(path.join(target, "restore-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(`\n${formatReport(verification)}`);
    console.log(`\ncomplete research-loop chains: ${verification.stats.completeChains} · referenced objects: ${verification.stats.referencedObjects}`);
    if (!verification.ok) {
      process.exitCode = 2;
      console.error("\nVERIFICATION FAILED — do not put this state into service.");
      return;
    }
    console.log("\nVERIFIED. Re-issue runner tokens with scripts/ops/reissue-runner-token.mjs; users sign in again.");
    if (options["emit-sql"]) {
      const sql = await emitSql(db, path.resolve(options["emit-sql"]));
      console.log(`SQL for wrangler d1 execute --remote --file: ${sql.restoreFile} (${sql.statements} statements); sequences: ${sql.sequencesFile}`);
    }
    if (options["emit-r2-dir"]) {
      const tree = await emitR2Tree(bucket, path.resolve(options["emit-r2-dir"]));
      console.log(`R2 tree for rclone copy: ${path.resolve(options["emit-r2-dir"])} (${tree.objects} objects)`);
    }
  } finally {
    await mf.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof RestoreRefusedError ? `REFUSED: ${error.message}` : error.message);
  if (!(error instanceof RestoreRefusedError)) console.error(USAGE);
  process.exitCode = 1;
});
