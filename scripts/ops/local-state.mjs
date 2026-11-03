// Opens a persisted Miniflare state directory (the layout Wrangler's
// `--persist-to <dir>` and the Cloudflare Vite plugin use: <dir>/v3/d1 and
// <dir>/v3/r2) with the same D1 database id and R2 bucket name as
// vite.config.ts / scripts/local-dev/wrangler.local.jsonc, so the dev server,
// `npm run db:migrate:local` and these ops scripts address the same files.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_STATE = path.join(ROOT, ".wrangler/state");
export const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
export const LOCAL_BUCKET_NAME = "site-creator-r2";

export async function openLocalState(stateDir) {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
    compatibilityDate: "2025-09-01",
    d1Databases: { DB: LOCAL_DATABASE_ID },
    d1Persist: path.join(stateDir, "v3/d1"),
    r2Buckets: { FILES: LOCAL_BUCKET_NAME },
    r2Persist: path.join(stateDir, "v3/r2"),
  });
  return { mf, db: await mf.getD1Database("DB"), bucket: await mf.getR2Bucket("FILES") };
}

/** Minimal `--flag value` / `--switch` parser. */
export function parseArgs(argv, { flags = [], switches = [] }) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const name = arg.replace(/^--/, "");
    if (switches.includes(name)) options[name] = true;
    else if (flags.includes(name) && index + 1 < argv.length) options[name] = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return options;
}
