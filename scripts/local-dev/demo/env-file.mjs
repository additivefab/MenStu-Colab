// Dev-server environment for the demo, kept in a marked block of `.env.local`
// (gitignored by `.env*`). The Cloudflare Vite plugin loads `.env` and
// `.env.local` from the project root into the Worker env, but only when no
// `.dev.vars` exists (wrangler's getVarsForDev): see devVarsConflict().
// The App key is a throwaway RSA key generated here; values are never printed.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { APP_ID, APP_SLUG, DEV_VARS_FILE, ENV_FILE } from "./constants.mjs";

const BEGIN = "# >>> tanyan demo-loop: LOCAL ONLY, synthetic throwaway values (scripts/local-dev/demo-loop.mjs) >>>";
const END = "# <<< tanyan demo-loop <<<";
export const DEMO_ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_API_BASE_URL"];

function readFileOrEmpty(file) {
  try { return readFileSync(file, "utf8"); } catch (error) { if (error?.code === "ENOENT") return ""; throw error; }
}

function splitBlock(text) {
  const start = text.indexOf(BEGIN);
  const end = start >= 0 ? text.indexOf(END, start) : -1;
  if (start < 0 || end < 0) return { before: text, block: null, after: "" };
  return { before: text.slice(0, start), block: text.slice(start + BEGIN.length, end), after: text.slice(end + END.length) };
}

function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"")) return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, "\"");
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

export function readDemoEnv() {
  const { block } = splitBlock(readFileOrEmpty(ENV_FILE));
  if (block === null) return null;
  const values = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = parseValue(match[2]);
  }
  return values;
}

/** Keys the demo needs that another, user-owned line of .env.local / .env also sets. */
export function conflictingUserKeys() {
  const conflicts = [];
  for (const file of [ENV_FILE, ENV_FILE.replace(/\.local$/, "")]) {
    const { before, after } = splitBlock(readFileOrEmpty(file));
    for (const line of `${before}\n${after}`.split(/\r?\n/)) {
      const key = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line)?.[1];
      if (key && DEMO_ENV_KEYS.includes(key)) conflicts.push(`${file.endsWith(".local") ? ".env.local" : ".env"}:${key}`);
    }
  }
  return conflicts;
}

export function devVarsConflict() {
  return existsSync(DEV_VARS_FILE);
}

function render(values) {
  const quoted = (value) => `"${value.replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
  return [
    BEGIN,
    "# Only for `npm run dev` against the local GitHub double. Never copy these to a hosted environment.",
    `GITHUB_APP_ID=${values.GITHUB_APP_ID}`,
    `GITHUB_APP_SLUG=${values.GITHUB_APP_SLUG}`,
    `GITHUB_APP_PRIVATE_KEY=${quoted(values.GITHUB_APP_PRIVATE_KEY)}`,
    `GITHUB_WEBHOOK_SECRET=${values.GITHUB_WEBHOOK_SECRET}`,
    `GITHUB_API_BASE_URL=${values.GITHUB_API_BASE_URL}`,
    END,
  ].join("\n");
}

function writeBlock(blockText) {
  const { before, after } = splitBlock(readFileOrEmpty(ENV_FILE));
  const head = before.replace(/\n*$/, "");
  const tail = after.replace(/^\n*/, "");
  const parts = [head, blockText, tail].filter(Boolean);
  writeFileSync(ENV_FILE, parts.length ? `${parts.join("\n\n").replace(/\n*$/, "")}\n` : "", { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

/**
 * Ensures the demo block exists for `apiBaseUrl`, reusing the stored key and
 * webhook secret so restarting the demo does not require restarting the dev
 * server. Returns the key pair for the GitHub double and whether the file changed.
 */
export function ensureDemoEnv(apiBaseUrl) {
  const existing = readDemoEnv() ?? {};
  let privateKeyPem = existing.GITHUB_APP_PRIVATE_KEY;
  let privateKey;
  try { privateKey = privateKeyPem ? createPrivateKey(privateKeyPem) : null; } catch { privateKey = null; }
  if (!privateKey) {
    privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  }
  const values = {
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_SLUG: APP_SLUG,
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_WEBHOOK_SECRET: existing.GITHUB_WEBHOOK_SECRET && existing.GITHUB_WEBHOOK_SECRET.length >= 32
      ? existing.GITHUB_WEBHOOK_SECRET : `synthetic-demo-${randomBytes(24).toString("hex")}`,
    GITHUB_API_BASE_URL: apiBaseUrl,
  };
  const changed = DEMO_ENV_KEYS.some((key) => existing[key] !== values[key]);
  if (changed) writeBlock(render(values));
  return { privateKey, publicKey: createPublicKey(privateKey), webhookSecret: values.GITHUB_WEBHOOK_SECRET, changed };
}

/** Removes the demo block (other lines of .env.local are kept). */
export function removeDemoEnv() {
  if (readDemoEnv() === null) return false;
  writeBlock("");
  return true;
}
