// Line-oriented logger that redacts every registered secret before writing.
// Secrets (runner token, short-lived repository tokens, derived auth headers)
// are registered as soon as they are read so no code path can print them.

export function createLogger({ write = (line) => process.stdout.write(`${line}\n`), prefix = "[lab-runner]" } = {}) {
  const secrets = new Set();

  function redact(text) {
    let output = String(text);
    for (const secret of secrets) {
      if (secret) output = output.split(secret).join("[REDACTED]");
    }
    return output;
  }

  function emit(level, message, fields) {
    const extra = fields && Object.keys(fields).length ? ` ${safeJson(fields)}` : "";
    write(redact(`${new Date().toISOString()} ${prefix} ${level} ${message}${extra}`));
  }

  return {
    addSecret(value) {
      if (typeof value === "string" && value.length >= 4) secrets.add(value);
    },
    redact,
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
