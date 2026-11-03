// HTTP client for the user's local dev server, logged in with the LOCAL-ONLY
// accounts from the gitignored .local-dev-admin.txt. Passwords and session
// tokens stay in memory; they are never printed or written anywhere else.
import { readFileSync } from "node:fs";

import { CREDENTIAL_FILE, LOGINS } from "./constants.mjs";

export function readCredentials() {
  let text = "";
  try { text = readFileSync(CREDENTIAL_FILE, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0 && !line.startsWith("#")) values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

export class PlatformError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Is something answering HTTP at `platformUrl`? */
export async function probeDevServer(platformUrl) {
  try {
    const response = await fetch(`${platformUrl}/api/auth/session`, { signal: AbortSignal.timeout(15_000) });
    await response.arrayBuffer();
    return { up: true, status: response.status };
  } catch (error) {
    return { up: false, error: error.cause?.code ?? error.message };
  }
}

export function createPlatformApi(platformUrl) {
  const origin = new URL(platformUrl).origin;
  const sessions = new Map();
  const credentials = readCredentials();

  async function login(actor) {
    const spec = LOGINS[actor];
    const username = credentials[spec.usernameKey];
    const password = credentials[spec.passwordKey];
    if (!username || !password) throw new PlatformError(`no local login for ${actor} in .local-dev-admin.txt`, 0, null);
    const response = await fetch(`${platformUrl}/api/auth/local/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ username, password }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new PlatformError(`login as ${username} failed: HTTP ${response.status} ${body.error ?? ""}`, response.status, body);
    const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).filter((pair) => !pair.endsWith("="));
    sessions.set(actor, cookies.join("; "));
    return username;
  }

  async function call(actor, path, { method = "GET", body, expect = [200] } = {}) {
    if (!sessions.has(actor)) await login(actor);
    const response = await fetch(platformUrl + path, {
      method,
      headers: { cookie: sessions.get(actor), ...(body === undefined ? {} : { "content-type": "application/json", origin }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
    if (!expect.includes(response.status)) {
      throw new PlatformError(`${method} ${path} as ${actor} → HTTP ${response.status}: ${data?.code ?? ""} ${data?.error ?? data?.raw ?? ""}`.trim(), response.status, data);
    }
    return data;
  }

  return {
    login,
    get: (actor, path, options) => call(actor, path, options),
    post: (actor, path, body, options = {}) => call(actor, path, { ...options, method: "POST", body }),
    usernames: { admin: credentials.username, student: credentials.synthetic_student_username, mentor: credentials.synthetic_mentor_username },
  };
}
