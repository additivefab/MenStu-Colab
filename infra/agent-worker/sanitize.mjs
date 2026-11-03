// Redaction and size capping for everything the worker sends or logs.
// Two layers: exact registered secrets (read token, OAuth token, worker
// token) are replaced literally; generic patterns catch secrets the worker
// never saw (a key the agent printed from somewhere).

import { LIMITS } from "../../lib/research-loop/contracts.ts";

const REDACTED = "[REDACTED]";

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /(x-access-token|oauth2|x-oauth-basic):[^@\s]+@/gi,
  /\b(AUTHORIZATION|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd)(["']?\s*[:=]\s*["']?)[^\s"',;@]{8,}/gi,
];

export class Redactor {
  constructor() {
    this.secrets = new Set();
  }

  /** Registers an exact secret value. Short values are ignored so that a
   * misconfigured empty token cannot blank every message. */
  add(value) {
    if (typeof value === "string" && value.trim().length >= 8) this.secrets.add(value.trim());
    return this;
  }

  redact(text) {
    if (typeof text !== "string" || !text) return text;
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(pattern, (match, ...groups) => {
        // Keep the key name for `key=value` style matches so logs stay readable.
        if (typeof groups[0] === "string" && typeof groups[1] === "string" && /[:=]/.test(groups[1])) {
          return `${groups[0]}${groups[1]}${REDACTED}`;
        }
        if (/^(Bearer|Basic|token)\s/i.test(match)) return `${match.split(/\s+/)[0]} ${REDACTED}`;
        if (match.endsWith("@") && typeof groups[0] === "string") return `${groups[0]}:${REDACTED}@`;
        return REDACTED;
      });
    }
    return out;
  }
}

export function truncate(text, maxChars) {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

const MAX_DEPTH = 6;
const MAX_KEYS = 50;
const MAX_ARRAY = 50;

/** Converts any value to a JSON-safe, redacted, size-bounded value. */
export function sanitizeValue(value, redactor, maxStringChars = 4000, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return truncate(redactor.redact(value), maxStringChars);
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, redactor, maxStringChars, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more items]`);
    return items;
  }
  if (typeof value === "object") {
    const out = {};
    const keys = Object.keys(value).slice(0, MAX_KEYS);
    for (const key of keys) out[redactor.redact(key)] = sanitizeValue(value[key], redactor, maxStringChars, depth + 1);
    return out;
  }
  return truncate(redactor.redact(String(value)), maxStringChars);
}

const byteLength = (text) => Buffer.byteLength(text, "utf8");

/** Sanitizes an event payload and guarantees it fits LIMITS.maxAgentEventPayloadBytes. */
export function sanitizePayload(payload, redactor, maxBytes = LIMITS.maxAgentEventPayloadBytes) {
  let maxStringChars = 4000;
  let safe = sanitizeValue(payload, redactor, maxStringChars);
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) safe = { value: safe };
  while (byteLength(JSON.stringify(safe)) > maxBytes && maxStringChars > 64) {
    maxStringChars = Math.floor(maxStringChars / 2);
    safe = sanitizeValue(payload, redactor, maxStringChars);
    if (!safe || typeof safe !== "object" || Array.isArray(safe)) safe = { value: safe };
  }
  const json = JSON.stringify(safe);
  if (byteLength(json) > maxBytes) {
    // Still too large (many keys): keep a redacted preview only.
    return { truncated: true, preview: truncate(json, Math.floor(maxBytes / 4)) };
  }
  return safe;
}

/** JSON-lines logger whose every line passes through the redactor. */
export function createLogger(redactor, write = (line) => process.stderr.write(line)) {
  const emit = (level, message, fields = {}) => {
    const record = { ts: new Date().toISOString(), level, message: redactor.redact(String(message)), ...sanitizeValue(fields, redactor, 2000) };
    write(`${JSON.stringify(record)}\n`);
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
