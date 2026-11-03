// Re-issues the bearer token of a lab runner / agent worker that a restore
// disabled. Keeps the runner id, so datasets and credential profiles bound to
// it keep working. The token is written to a 0600 file and never printed.
//
// Local state:
//   node scripts/ops/reissue-runner-token.mjs --runner <id> [--state .wrangler/state] [--token-file <path>]
// Production (no write access from here): emit the SQL, apply it with
//   wrangler d1 execute <DB> --remote --file <sql>, then move the token file to the runner host.
//   node scripts/ops/reissue-runner-token.mjs --runner <id> --emit-sql <file> [--token-file <path>]
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_STATE, ROOT, openLocalState, parseArgs } from "./local-state.mjs";

const USAGE = "Usage: reissue-runner-token.mjs --runner <id> [--state <dir> | --emit-sql <file>] [--token-file <path>]";

async function main() {
  const options = parseArgs(process.argv.slice(2), { flags: ["runner", "state", "emit-sql", "token-file"], switches: ["help"] });
  if (options.help) { console.log(USAGE); return; }
  if (!options.runner || !/^[A-Za-z0-9_-]{1,80}$/.test(options.runner)) throw new Error("--runner <id> is required");
  // Same format as lib/lab-runner-auth.ts issueRunnerToken(): 32 random bytes, base64url.
  const token = randomBytes(32).toString("base64url");
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const tokenFile = path.resolve(options["token-file"] ?? path.join(ROOT, `.wrangler/runner-token-${options.runner}.txt`));

  if (options["emit-sql"]) {
    const sql = `UPDATE lab_runners SET token_sha256 = '${tokenSha256}', status = 'active' WHERE id = '${options.runner}';\n`;
    await writeFile(path.resolve(options["emit-sql"]), sql, { mode: 0o600 });
    console.log(`SQL written: ${path.resolve(options["emit-sql"])} (contains only the hash)`);
  } else {
    const { mf, db } = await openLocalState(path.resolve(options.state ?? DEFAULT_STATE));
    try {
      const result = await db.prepare("UPDATE lab_runners SET token_sha256 = ?, status = 'active' WHERE id = ?").bind(tokenSha256, options.runner).run();
      if (!result.meta.changes) throw new Error(`Runner ${options.runner} not found`);
    } finally {
      await mf.dispose();
    }
    console.log(`Runner ${options.runner} re-enabled with a new token.`);
  }
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  console.log(`Token file (0600, configure it on the runner host, then delete): ${tokenFile}`);
}

main().catch((error) => {
  console.error(error.message);
  console.error(USAGE);
  process.exitCode = 1;
});
