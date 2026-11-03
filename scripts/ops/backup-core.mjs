// Backup / restore / verification core for D1 + R2 (acceptance T26).
//
// Used by scripts/ops/backup.mjs, scripts/ops/restore.mjs and the drill test
// tests/ops-backup-restore.test.mjs. Every function takes a D1Database and an
// R2Bucket (Miniflare's local implementations in practice), so the same code
// path runs in the drill and against the local `.wrangler/state`.
//
// Backup layout (one timestamped directory; manifest.json is written last, so a
// directory without it is an incomplete backup):
//   manifest.json            format, schema version, row counts, file hashes, R2 list
//   d1/schema.json           DDL from sqlite_master, FK insert order, AUTOINCREMENT sequences
//   d1/tables/<table>.jsonl  header line + one JSON array per row (typed cells, see encodeCell)
//   r2/blobs/<sha256>        object bytes, content-addressed (keys never become paths)
//
// Secrets: Worker secrets (GitHub App key, webhook secret, Feishu secrets,
// RESEARCH_OUTPUT_CREDENTIALS_KEY) live only in Cloudflare's secret store and are
// never read here. D1 holds only token *hashes*; restore invalidates all of them
// (invalidateRestoredCredentials). See docs/ops/备份与恢复.md.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const BACKUP_FORMAT = "tanyan.backup/v1";

/** Tables emptied on restore; their expected post-restore row count is 0. */
export const INVALIDATED_EMPTY_TABLES = ["app_sessions", "local_auth_attempts"];

/** Column-level decisions recorded in every manifest (and in the ops doc). */
export const SENSITIVE_COLUMN_POLICY = {
  "app_sessions.token_hash": "exported (SHA-256 of the session cookie); every row is deleted on restore",
  "lab_runners.token_sha256": "exported; on restore every runner is disabled and its hash replaced by a random unmatched value (re-issue with reissue-runner-token.mjs)",
  "local_credentials.activation_hash": "exported; cleared on restore, pending activations must be re-issued",
  "local_credentials.password_hash": "exported on purpose (salted scrypt) so students keep their logins after a restore; the backup must be stored encrypted with restricted access",
  "local_auth_attempts.*": "exported (rate-limit windows); emptied on restore",
  "research_outputs.submission_password_ciphertext": "exported as AES-GCM ciphertext only; the key RESEARCH_OUTPUT_CREDENTIALS_KEY is a Worker secret backed up separately",
  "github installation tokens": "never stored in D1/R2 (minted per request, 1 h lifetime); nothing to export or clear",
  "worker secrets": "never exported (not reachable from D1/R2)",
};

/** Text that looks like live credential material. Backups refuse it by default. */
const SECRET_PATTERNS = [
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["api_key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const q = (identifier) => `"${String(identifier).replaceAll("\"", "\"\"")}"`;
const isInternalTable = (name) => /^sqlite_/i.test(name) || /^_cf_/i.test(name);
const SHA256_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Cell encoding: exact round trip of SQLite storage classes through JSON.
//   null | string (TEXT) | number (safe INTEGER or non-integral REAL)
//   {"int": "<decimal>"} INTEGER outside JS safe range
//   {"real": n}          integral REAL (keeps REAL storage class)
//   {"hex": "<HEX>"}     BLOB
// ---------------------------------------------------------------------------
function decodeStorage(type, value) {
  switch (type) {
    case "null": return null;
    case "integer": {
      const n = Number(value);
      return Number.isSafeInteger(n) ? n : { int: String(value) };
    }
    case "real": {
      const n = Number(value);
      if (!Number.isFinite(n)) return { real: String(n) };
      return Number.isInteger(n) ? { real: n } : n;
    }
    case "blob": return { hex: String(value).toUpperCase() };
    default: return value === null ? null : String(value);
  }
}

/** Returns [sqlFragment, binds[]] for one encoded cell (literals are validated). */
function cellSql(cell) {
  if (cell === null || typeof cell === "string" || typeof cell === "number") return ["?", [cell]];
  if (cell && typeof cell.int === "string" && /^-?\d{1,20}$/.test(cell.int)) return [cell.int, []];
  if (cell && "real" in cell) return ["CAST(? AS REAL)", [typeof cell.real === "number" ? cell.real : String(cell.real)]];
  if (cell && typeof cell.hex === "string" && /^(?:[0-9A-F]{2})*$/.test(cell.hex)) return [`X'${cell.hex}'`, []];
  throw new Error(`invalid encoded cell ${JSON.stringify(cell).slice(0, 80)}`);
}

/** SQL literal for --emit-sql: one statement per line (newlines become char(10)). */
function cellLiteral(cell) {
  if (cell === null) return "NULL";
  if (typeof cell === "number") return String(cell);
  if (typeof cell === "string") {
    if (cell === "") return "''";
    const parts = cell.split(/(\r|\n)/).map((part) => (part === "\n" ? "char(10)" : part === "\r" ? "char(13)" : `'${part.replaceAll("'", "''")}'`))
      .filter((part) => part !== "''");
    return parts.length === 1 ? parts[0] : `(${parts.join(" || ")})`;
  }
  const [fragment, binds] = cellSql(cell);
  if (!binds.length) return fragment;
  const value = binds[0];
  return `CAST(${typeof value === "number" ? (Number.isInteger(value) ? `${value}.0` : String(value)) : `'${value}'`} AS REAL)`;
}

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------
async function schemaObjects(db) {
  const { results } = await db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL ORDER BY rowid`).all();
  return results.filter((row) => !isInternalTable(row.name) && !isInternalTable(row.tbl_name));
}

export async function listUserTables(db) {
  return (await schemaObjects(db)).filter((row) => row.type === "table").map((row) => row.name);
}

// Local D1 calls go through Miniflare's loopback proxy; batching keeps the
// number of round trips (and sockets) small regardless of table count.
const BATCH_SIZE = 50;
async function batchAll(db, statements) {
  const results = [];
  for (let start = 0; start < statements.length; start += BATCH_SIZE) {
    results.push(...await db.batch(statements.slice(start, start + BATCH_SIZE)));
  }
  return results;
}

async function tableColumnsMap(db, tables) {
  const results = await batchAll(db, tables.map((table) => db.prepare(`PRAGMA table_info(${q(table)})`)));
  return new Map(tables.map((table, index) => [table, results[index].results.map((row) => row.name)]));
}

/** Parents before children (FK graph); cycles and self references keep schema order. */
async function insertOrder(db, tables) {
  const results = await batchAll(db, tables.map((table) => db.prepare(`PRAGMA foreign_key_list(${q(table)})`)));
  const deps = new Map(tables.map((table, index) => [table,
    new Set(results[index].results.map((row) => row.table).filter((parent) => parent !== table && tables.includes(parent)))]));
  const order = [];
  const done = new Set();
  let progressed = true;
  while (order.length < tables.length && progressed) {
    progressed = false;
    for (const table of tables) {
      if (done.has(table)) continue;
      if ([...deps.get(table)].every((parent) => done.has(parent))) {
        order.push(table);
        done.add(table);
        progressed = true;
      }
    }
  }
  for (const table of tables) if (!done.has(table)) order.push(table);
  return order;
}

async function readSequences(db) {
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").first();
  if (!exists) return [];
  const { results } = await db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all();
  return results.filter((row) => !isInternalTable(row.name)).map((row) => ({ name: row.name, seq: Number(row.seq) }));
}

async function schemaVersion(db) {
  try {
    const row = await db.prepare("SELECT version FROM app_schema_meta WHERE id = 1").first();
    return row ? Number(row.version) : null;
  } catch {
    return null;
  }
}

async function appliedMigrations(db) {
  try {
    const { results } = await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
    return results.map((row) => row.name);
  } catch {
    return null; // Not migrated through wrangler (e.g. the test fixture); app_schema_meta is authoritative.
  }
}

async function countRows(db, tables) {
  const results = await batchAll(db, tables.map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`)));
  return new Map(tables.map((table, index) => [table, Number(results[index].results[0].n)]));
}

const PAGE_SIZE = 500;
function pageStatement(db, table, columns, offset) {
  // Storage class + exact value per column (aliased so result objects keep every cell).
  const select = columns.map((column, index) => `typeof(${q(column)}) AS t${index}, CASE typeof(${q(column)}) WHEN 'blob' THEN hex(${q(column)})
    WHEN 'integer' THEN CAST(${q(column)} AS TEXT) ELSE ${q(column)} END AS v${index}`).join(", ");
  return db.prepare(`SELECT ${select} FROM ${q(table)} ORDER BY rowid LIMIT ${PAGE_SIZE} OFFSET ${offset}`);
}

function decodePage(columns, results) {
  return results.map((values) => columns.map((_, index) => decodeStorage(values[`t${index}`], values[`v${index}`])));
}

/** Every row of every table as encoded cell arrays: Map<table, rows[]>. */
export async function readAllRows(db, tables, columnsMap) {
  const firstPages = await batchAll(db, tables.map((table) => pageStatement(db, table, columnsMap.get(table), 0)));
  const rows = new Map();
  for (const [index, table] of tables.entries()) {
    const columns = columnsMap.get(table);
    const all = decodePage(columns, firstPages[index].results);
    for (let offset = PAGE_SIZE; all.length === offset; offset += PAGE_SIZE) {
      all.push(...decodePage(columns, (await pageStatement(db, table, columns, offset).all()).results));
    }
    rows.set(table, all);
  }
  return rows;
}

function scanCells(table, columns, row, rowIndex, findings) {
  row.forEach((cell, index) => {
    if (typeof cell !== "string") return;
    for (const [pattern, regex] of SECRET_PATTERNS) {
      if (regex.test(cell)) findings.push({ table, column: columns[index], rowIndex, pattern });
    }
  });
}

// ---------------------------------------------------------------------------
// R2 references held by D1 rows (key + expected sha256 of the object bytes)
// ---------------------------------------------------------------------------
const R2_REFERENCE_QUERIES = [
  ["run_artifact", "run_artifacts", "SELECT id AS ref, r2_key AS key, sha256 FROM run_artifacts WHERE r2_key IS NOT NULL"],
  ["agent_change", "agent_attempts", "SELECT id AS ref, diff_r2_key AS key, diff_sha256 AS sha256 FROM agent_attempts WHERE diff_r2_key IS NOT NULL"],
  ["progress_attachment", "progress_attachments", "SELECT CAST(id AS TEXT) AS ref, storage_key AS key, content_sha256 AS sha256 FROM progress_attachments"],
  ["resolution_attachment", "progress_resolution_attachments", "SELECT CAST(id AS TEXT) AS ref, storage_key AS key, content_sha256 AS sha256 FROM progress_resolution_attachments"],
];

export async function referencedObjects(db) {
  const tables = new Set(await listUserTables(db));
  const queries = R2_REFERENCE_QUERIES.filter(([, table]) => tables.has(table));
  const results = await batchAll(db, queries.map(([, , sql]) => db.prepare(sql)));
  return queries.flatMap(([kind], index) => results[index].results.map((row) =>
    ({ kind, ref: row.ref, key: row.key, sha256: row.sha256 ? String(row.sha256).toLowerCase() : null })));
}

async function listAllObjects(bucket) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ cursor, limit: 1000, include: ["httpMetadata", "customMetadata"] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function objectBytes(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  return Buffer.from(await object.arrayBuffer());
}

/** key -> sha256 of the bytes, for every object in the bucket (one GET each). */
async function hashAllObjects(bucket) {
  const hashes = new Map();
  for (const object of await listAllObjects(bucket)) {
    const bytes = await objectBytes(bucket, object.key);
    if (bytes) hashes.set(object.key, sha256(bytes));
  }
  return hashes;
}

/** Every DB-referenced object exists with matching bytes. */
function checkReferences(references, hashes) {
  const missing = [];
  const mismatched = [];
  for (const reference of references) {
    const actual = hashes.get(reference.key);
    if (actual === undefined) missing.push({ kind: reference.kind, ref: reference.ref, key: reference.key });
    else if (reference.sha256 && actual !== reference.sha256) mismatched.push({ kind: reference.kind, ref: reference.ref, key: reference.key });
  }
  return { referenced: references.length, missing, mismatched };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------
function timestamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

async function writeJsonFile(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Exports D1 + R2 into `<outDir>/backup-<UTC timestamp>/`. Refuses (throws) when
 * text cells look like live credentials unless `allowSecretFindings` is set.
 */
export async function createBackup({ db, bucket, outDir, source = { kind: "local" }, now = new Date(), allowSecretFindings = false, log = () => {} }) {
  const name = `backup-${timestamp(now)}`;
  const finalDir = path.resolve(outDir, name);
  const workDir = `${finalDir}.partial`;
  await rm(workDir, { recursive: true, force: true });
  await mkdir(path.join(workDir, "d1", "tables"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(workDir, "r2", "blobs"), { recursive: true, mode: 0o700 });
  try {
    const objects = await schemaObjects(db);
    const tables = objects.filter((row) => row.type === "table").map((row) => row.name);
    const schema = {
      objects: objects.map(({ type, name: objectName, tbl_name: tableName, sql }) => ({ type, name: objectName, table: tableName, sql })),
      insertOrder: await insertOrder(db, tables),
      sequences: await readSequences(db),
    };
    const schemaText = `${JSON.stringify(schema, null, 2)}\n`;
    await writeFile(path.join(workDir, "d1", "schema.json"), schemaText, { mode: 0o600 });

    const tableManifest = {};
    const findings = [];
    const columnsMap = await tableColumnsMap(db, tables);
    const allRows = await readAllRows(db, tables, columnsMap);
    for (const table of tables) {
      const columns = columnsMap.get(table);
      const lines = [JSON.stringify({ table, columns })];
      allRows.get(table).forEach((row, rowIndex) => {
        scanCells(table, columns, row, rowIndex, findings);
        lines.push(JSON.stringify(row));
      });
      const rows = lines.length - 1;
      const file = `d1/tables/${encodeURIComponent(table)}.jsonl`;
      const text = `${lines.join("\n")}\n`;
      await writeFile(path.join(workDir, file), text, { mode: 0o600 });
      tableManifest[table] = { rows, columns: columns.length, file, sha256: sha256(text) };
      log(`d1 ${table}: ${rows}`);
    }
    if (findings.length && !allowSecretFindings) {
      const summary = findings.slice(0, 10).map((item) => `${item.table}.${item.column}#${item.rowIndex} (${item.pattern})`).join(", ");
      throw new Error(`Refusing to write a backup: ${findings.length} cell(s) look like live credentials: ${summary}. `
        + "Remove them at the source, or rerun with --allow-secret-findings after review.");
    }

    const r2Objects = [];
    let totalBytes = 0;
    for (const object of await listAllObjects(bucket)) {
      const bytes = await objectBytes(bucket, object.key);
      if (!bytes) throw new Error(`R2 object disappeared during backup: ${object.key}`);
      const digest = sha256(bytes);
      const blob = path.join(workDir, "r2", "blobs", digest);
      try { await stat(blob); } catch { await writeFile(blob, bytes, { mode: 0o600 }); }
      r2Objects.push({
        key: object.key, size: bytes.length, sha256: digest,
        contentType: object.httpMetadata?.contentType ?? null,
        customMetadata: object.customMetadata && Object.keys(object.customMetadata).length ? object.customMetadata : null,
        uploaded: object.uploaded instanceof Date ? object.uploaded.toISOString() : object.uploaded ?? null,
      });
      totalBytes += bytes.length;
    }
    r2Objects.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    log(`r2 objects: ${r2Objects.length} (${totalBytes} bytes)`);

    // Source preflight: references already broken at the source are recorded, so a
    // failed restore verification can be told apart from a damaged restore.
    const references = await referencedObjects(db);
    const sourceReferences = checkReferences(references, new Map(r2Objects.map((item) => [item.key, item.sha256])));
    const referencedKeys = new Set(references.map((item) => item.key));

    const manifest = {
      format: BACKUP_FORMAT,
      name,
      createdAt: now.toISOString(),
      source,
      schema: {
        appSchemaVersion: await schemaVersion(db),
        d1Migrations: await appliedMigrations(db),
        file: "d1/schema.json",
        sha256: sha256(schemaText),
      },
      d1: { tables: tableManifest, totalRows: Object.values(tableManifest).reduce((sum, item) => sum + item.rows, 0) },
      r2: {
        binding: "FILES",
        objects: r2Objects,
        totalBytes,
        referencedByDatabase: sourceReferences.referenced,
        unreferencedKeys: r2Objects.filter((item) => !referencedKeys.has(item.key)).length,
      },
      sourcePreflight: { missingObjects: sourceReferences.missing, mismatchedObjects: sourceReferences.mismatched },
      secrets: {
        exported: false,
        secretScanFindings: findings.map(({ table, column, rowIndex, pattern }) => ({ table, column, rowIndex, pattern })),
        columnPolicy: SENSITIVE_COLUMN_POLICY,
      },
    };
    await writeJsonFile(path.join(workDir, "manifest.json"), manifest);
    await rename(workDir, finalDir);
    return { dir: finalDir, manifest };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Backup reading and integrity
// ---------------------------------------------------------------------------
export async function readBackup(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  if (manifest.format !== BACKUP_FORMAT) throw new Error(`Unsupported backup format ${manifest.format}`);
  return manifest;
}

/** Verifies every file of the backup against the manifest before anything is loaded. */
export async function verifyBackupFiles(dir, manifest) {
  const problems = [];
  const schemaText = await readFile(path.join(dir, manifest.schema.file), "utf8").catch(() => null);
  if (schemaText === null || sha256(schemaText) !== manifest.schema.sha256) problems.push(`schema file ${manifest.schema.file}`);
  for (const [table, entry] of Object.entries(manifest.d1.tables)) {
    const text = await readFile(path.join(dir, entry.file), "utf8").catch(() => null);
    if (text === null || sha256(text) !== entry.sha256) problems.push(`table file ${table}`);
  }
  const blobs = new Set(await readdir(path.join(dir, "r2", "blobs")).catch(() => []));
  for (const object of manifest.r2.objects) {
    if (!SHA256_RE.test(object.sha256) || !blobs.has(object.sha256)) { problems.push(`r2 blob for ${object.key}`); continue; }
    const bytes = await readFile(path.join(dir, "r2", "blobs", object.sha256));
    if (sha256(bytes) !== object.sha256 || bytes.length !== object.size) problems.push(`r2 blob for ${object.key}`);
  }
  return problems;
}

async function readTableFile(dir, entry) {
  const lines = (await readFile(path.join(dir, entry.file), "utf8")).split("\n").filter(Boolean);
  const header = JSON.parse(lines[0]);
  return { columns: header.columns, rows: lines.slice(1).map((line) => JSON.parse(line)) };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------
export class RestoreRefusedError extends Error {}

export async function targetState(db, bucket) {
  const tables = await listUserTables(db);
  const objects = (await bucket.list({ limit: 1 })).objects.length;
  return { tables, hasObjects: objects > 0, empty: tables.length === 0 && objects === 0 };
}

async function wipeTarget(db, bucket) {
  await db.prepare("PRAGMA foreign_keys = OFF").run().catch(() => undefined);
  const objects = await schemaObjects(db);
  await batchAll(db, [
    ...objects.filter((item) => item.type === "trigger").map((item) => db.prepare(`DROP TRIGGER IF EXISTS ${q(item.name)}`)),
    ...objects.filter((item) => item.type === "view").map((item) => db.prepare(`DROP VIEW IF EXISTS ${q(item.name)}`)),
  ]);
  for (const table of await listUserTables(db)) await db.prepare(`DROP TABLE IF EXISTS ${q(table)}`).run();
  for (const object of await listAllObjects(bucket)) await bucket.delete(object.key);
}

function insertStatement(db, table, columns, row) {
  const fragments = [];
  const binds = [];
  for (const cell of row) {
    const [fragment, values] = cellSql(cell);
    fragments.push(fragment);
    binds.push(...values);
  }
  return db.prepare(`INSERT INTO ${q(table)} (${columns.map(q).join(", ")}) VALUES (${fragments.join(", ")})`).bind(...binds);
}

/**
 * Loads a verified backup into an EMPTY target, invalidates every restored
 * credential, then verifies. Throws RestoreRefusedError for a non-empty target
 * (unless `force`, which wipes it) or a backup whose files fail their hashes.
 */
export async function restoreBackup({ db, bucket, backupDir, force = false, log = () => {} }) {
  const manifest = await readBackup(backupDir);
  const damaged = await verifyBackupFiles(backupDir, manifest);
  if (damaged.length) throw new RestoreRefusedError(`Backup files fail their manifest hashes: ${damaged.slice(0, 10).join(", ")}`);

  const before = await targetState(db, bucket);
  if (!before.empty) {
    if (!force) {
      throw new RestoreRefusedError(`Target is not empty (${before.tables.length} table(s)${before.hasObjects ? ", R2 objects present" : ""}); `
        + "restore only into a fresh database, or pass --force to wipe it first.");
    }
    log("--force: wiping the non-empty target");
    await wipeTarget(db, bucket);
  }

  const schema = JSON.parse(await readFile(path.join(backupDir, manifest.schema.file), "utf8"));
  // Tables first, then data (parents first, FK checks deferred per batch), then
  // AUTOINCREMENT counters, then indexes, triggers and views.
  await batchAll(db, schema.objects.filter((item) => item.type === "table").map((item) => db.prepare(item.sql)));
  await db.prepare("PRAGMA foreign_keys = OFF").run().catch(() => undefined);
  let pending = [];
  const flush = async () => {
    if (pending.length) await db.batch([db.prepare("PRAGMA defer_foreign_keys = ON"), ...pending]);
    pending = [];
  };
  for (const table of schema.insertOrder) {
    const entry = manifest.d1.tables[table];
    if (!entry) continue;
    const { columns, rows } = await readTableFile(backupDir, entry);
    for (const row of rows) {
      pending.push(insertStatement(db, table, columns, row));
      if (pending.length >= 200) await flush();
    }
    log(`d1 ${table}: ${rows.length}`);
  }
  await flush();
  if (schema.sequences.length) {
    await batchAll(db, schema.sequences.flatMap(({ name, seq }) => [
      db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").bind(seq, name),
      db.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)").bind(name, seq, name),
    ]));
  }
  await batchAll(db, ["index", "trigger", "view"].flatMap((type) => schema.objects.filter((item) => item.type === type).map((item) => db.prepare(item.sql))));
  await db.prepare("PRAGMA foreign_keys = ON").run().catch(() => undefined);

  for (const object of manifest.r2.objects) {
    const bytes = await readFile(path.join(backupDir, "r2", "blobs", object.sha256));
    const options = {};
    if (object.contentType) options.httpMetadata = { contentType: object.contentType };
    if (object.customMetadata) options.customMetadata = object.customMetadata;
    await bucket.put(object.key, bytes, options);
  }
  log(`r2 objects: ${manifest.r2.objects.length}`);

  // Invalidate BEFORE verifying: a restored database never holds a usable old token,
  // even if a later verification step fails.
  const invalidation = await invalidateRestoredCredentials(db);
  const verification = await verifyRestore({ db, bucket, manifest, backupDir, invalidated: true });
  return { manifest, invalidation, verification };
}

// ---------------------------------------------------------------------------
// Post-restore credential invalidation (T26: never treat an old token as valid)
// ---------------------------------------------------------------------------
export async function invalidateRestoredCredentials(db) {
  const tableList = await listUserTables(db);
  const tables = new Set(tableList);
  const summary = { sessionsDeleted: 0, runnersDisabled: 0, activationsCleared: 0, authAttemptsCleared: 0, githubTokensCleared: 0 };
  const statements = [];
  const keys = [];
  if (tables.has("app_sessions")) { statements.push(db.prepare("DELETE FROM app_sessions")); keys.push("sessionsDeleted"); }
  if (tables.has("local_credentials")) {
    statements.push(db.prepare(`UPDATE local_credentials SET activation_hash = NULL, activation_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE activation_hash IS NOT NULL OR activation_expires_at IS NOT NULL`));
    keys.push("activationsCleared");
  }
  if (tables.has("local_auth_attempts")) { statements.push(db.prepare("DELETE FROM local_auth_attempts")); keys.push("authAttemptsCleared"); }
  if (tables.has("lab_runners")) {
    const { results } = await db.prepare("SELECT id FROM lab_runners").all();
    for (const { id } of results) {
      // Not a hex digest of anything: no bearer token can ever hash to it.
      statements.push(db.prepare("UPDATE lab_runners SET status = 'disabled', token_sha256 = ? WHERE id = ?")
        .bind(`revoked-by-restore:${randomBytes(24).toString("hex")}`, id));
      keys.push("runnersDisabled");
    }
  }
  const results = await batchAll(db, statements);
  results.forEach((result, index) => { summary[keys[index]] += Number(result.meta.changes ?? 0); });
  // GitHub installation tokens are minted per request and never persisted
  // (lib/github/tokens.ts); assert no table grew a column that could hold one.
  const tokenColumns = [];
  for (const [table, columns] of await tableColumnsMap(db, tableList)) {
    for (const column of columns) {
      if (/(access|installation|github|oauth)_?token(?!_?sha256|_?hash)/i.test(column)) tokenColumns.push(`${table}.${column}`);
    }
  }
  summary.unexpectedTokenColumns = tokenColumns;
  return summary;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
/** Research-loop relation checks: each query returns offending ids (must be none). */
const RELATION_CHECKS = [
  ["task_current_version", "任务当前版本存在", `SELECT t.id FROM research_tasks t WHERE NOT EXISTS
    (SELECT 1 FROM research_task_versions v WHERE v.task_id = t.id AND v.version = t.current_version)`],
  ["task_confirmed_version", "任务已确认版本存在", `SELECT t.id FROM research_tasks t WHERE t.confirmed_version IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM research_task_versions v WHERE v.task_id = t.id AND v.version = t.confirmed_version)`],
  ["task_parent", "父任务存在（谱系）", `SELECT t.id FROM research_tasks t WHERE t.parent_task_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM research_tasks p WHERE p.id = t.parent_task_id)`],
  ["task_source_run", "来源运行存在（谱系）", `SELECT t.id FROM research_tasks t WHERE t.source_run_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = t.source_run_id)`],
  ["attempt_task_version", "代理尝试绑定的任务版本存在且学生一致", `SELECT a.id FROM agent_attempts a LEFT JOIN research_tasks t ON t.id = a.task_id
    WHERE t.id IS NULL OR t.student_id <> a.student_id OR NOT EXISTS
    (SELECT 1 FROM research_task_versions v WHERE v.task_id = a.task_id AND v.version = a.task_version)`],
  ["attempt_change_artifact", "已产出变更的尝试带有变更文件引用", `SELECT id FROM agent_attempts
    WHERE status = 'change_ready' AND (diff_r2_key IS NULL OR diff_sha256 IS NULL)`],
  ["change_request_attempt", "变更请求与代理尝试一致（任务、学生、仓库、基线）", `SELECT c.id FROM change_requests c LEFT JOIN agent_attempts a ON a.id = c.attempt_id
    WHERE a.id IS NULL OR a.task_id <> c.task_id OR a.student_id <> c.student_id
      OR a.github_repository_id <> c.github_repository_id OR a.base_commit_sha <> c.base_commit_sha`],
  ["run_spec_task", "运行规范绑定的任务版本存在", `SELECT s.sha256 FROM run_specs s WHERE NOT EXISTS
    (SELECT 1 FROM research_task_versions v WHERE v.task_id = s.task_id AND v.version = s.task_version)`],
  ["run_spec_change_request", "运行规范引用的变更请求属于同一任务", `SELECT s.sha256 FROM run_specs s JOIN change_requests c ON c.id = s.change_request_id
    WHERE c.task_id <> s.task_id OR c.student_id <> s.student_id`],
  ["run_spec", "运行与规范一致（任务、学生）", `SELECT r.id FROM runs r LEFT JOIN run_specs s ON s.sha256 = r.run_spec_sha256
    WHERE s.sha256 IS NULL OR s.task_id <> r.task_id OR s.student_id <> r.student_id`],
  ["run_approval", "运行引用的批准绑定同一规范哈希", `SELECT r.id FROM runs r JOIN run_approvals p ON p.id = r.approval_id
    WHERE p.run_spec_sha256 <> r.run_spec_sha256`],
  ["run_events_sequence", "运行事件序号从 1 连续", `SELECT run_id FROM run_events GROUP BY run_id
    HAVING MIN(sequence) <> 1 OR MAX(sequence) <> COUNT(*) OR COUNT(DISTINCT sequence) <> COUNT(*)`],
  ["result_metrics_source", "结果指标来源产物属于同一运行", `SELECT x.run_id FROM run_results x JOIN run_artifacts a ON a.id = x.metrics_source_artifact_id
    WHERE a.run_id <> x.run_id`],
  ["review_result", "结果评审对应已登记的结果", `SELECT v.run_id FROM result_reviews v WHERE NOT EXISTS
    (SELECT 1 FROM run_results x WHERE x.run_id = v.run_id)`],
  ["review_followup", "评审的跟进任务指回该运行（谱系）", `SELECT v.run_id FROM result_reviews v LEFT JOIN research_tasks t ON t.id = v.followup_task_id
    WHERE v.followup_task_id IS NOT NULL AND (t.id IS NULL OR t.source_run_id IS NULL OR t.source_run_id <> v.run_id)`],
  ["baseline_runs", "基线运行存在", `SELECT b.run_id FROM run_baselines b WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = b.baseline_run_id)`],
  ["comment_parent", "评论回复指向同一运行的评论", `SELECT c.id FROM result_comments c LEFT JOIN result_comments p ON p.id = c.parent_comment_id
    WHERE c.parent_comment_id IS NOT NULL AND (p.id IS NULL OR p.run_id <> c.run_id)`],
];

/** Number of complete chains task→version→attempt→change request→spec→run→result→review. */
const CHAIN_QUERY = `SELECT COUNT(DISTINCT r.id) AS chains FROM runs r
  JOIN run_specs s ON s.sha256 = r.run_spec_sha256
  JOIN change_requests c ON c.id = s.change_request_id
  JOIN agent_attempts a ON a.id = c.attempt_id
  JOIN research_task_versions v ON v.task_id = a.task_id AND v.version = a.task_version
  JOIN research_tasks t ON t.id = r.task_id
  JOIN run_results x ON x.run_id = r.id
  JOIN result_reviews w ON w.run_id = r.id`;

const check = (id, label, violations, detail = "", samples = []) => ({
  id, label, status: violations === 0 ? "pass" : "fail", violations, detail, samples: samples.slice(0, 10),
});

/**
 * Verifies a restored target against its manifest. `invalidated` means the
 * credential invalidation already ran (sessions/auth attempts expected empty,
 * runners disabled with unknown hashes).
 */
export async function verifyRestore({ db, bucket, manifest, backupDir = null, invalidated = true }) {
  const checks = [];
  const tables = new Set(await listUserTables(db));

  // 1. Foreign keys.
  const fk = (await db.prepare("PRAGMA foreign_key_check").all()).results;
  checks.push(check("foreign_keys", "外键完整（PRAGMA foreign_key_check）", fk.length, "", fk.map((row) => `${row.table}#${row.rowid}→${row.parent}`)));

  // 2. Row counts.
  const countIssues = [];
  const present = Object.keys(manifest.d1.tables).filter((table) => tables.has(table));
  const counts = await countRows(db, present);
  for (const [table, entry] of Object.entries(manifest.d1.tables)) {
    if (!tables.has(table)) { countIssues.push(`${table}: missing`); continue; }
    const actual = counts.get(table);
    const expected = invalidated && INVALIDATED_EMPTY_TABLES.includes(table) ? 0 : entry.rows;
    if (actual !== expected) countIssues.push(`${table}: ${actual} ≠ ${expected}`);
  }
  for (const table of tables) if (!(table in manifest.d1.tables)) countIssues.push(`${table}: not in backup`);
  checks.push(check("row_counts", "各表行数与清单一致", countIssues.length,
    `${Object.keys(manifest.d1.tables).length} 张表，备份时共 ${manifest.d1.totalRows} 行`, countIssues));

  // 3. Schema version.
  const version = await schemaVersion(db);
  checks.push(check("schema_version", "schema 版本与备份一致", version === manifest.schema.appSchemaVersion ? 0 : 1,
    `v${version ?? "未记录"} / 备份 v${manifest.schema.appSchemaVersion ?? "未记录"}`));

  // 4. Research-loop relations (one batch; per-query fallback names a failing query).
  let relationResults = null;
  try { relationResults = await batchAll(db, RELATION_CHECKS.map(([, , sql]) => db.prepare(sql))); } catch { relationResults = null; }
  for (const [index, [id, label, sql]] of RELATION_CHECKS.entries()) {
    try {
      const rows = (relationResults ? relationResults[index].results : (await db.prepare(sql).all()).results).map((row) => String(Object.values(row)[0]));
      checks.push(check(`relation_${id}`, label, rows.length, "", rows));
    } catch (error) {
      checks.push(check(`relation_${id}`, label, 1, `查询失败：${error.message}`));
    }
  }
  const hashIssues = [];
  if (tables.has("run_specs")) {
    for (const row of (await db.prepare("SELECT sha256, canonical_json FROM run_specs").all()).results) {
      if (sha256(row.canonical_json) !== row.sha256) hashIssues.push(`run_specs ${row.sha256}`);
    }
  }
  if (tables.has("run_results")) {
    for (const row of (await db.prepare("SELECT run_id, manifest_sha256, manifest_json FROM run_results").all()).results) {
      if (sha256(row.manifest_json) !== row.manifest_sha256) hashIssues.push(`run_results ${row.run_id}`);
    }
  }
  checks.push(check("relation_content_hashes", "运行规范与结果清单的哈希可复算（批准绑定未被改动）", hashIssues.length, "", hashIssues));
  let chains = 0;
  try { chains = Number((await db.prepare(CHAIN_QUERY).first()).chains); } catch { chains = 0; }

  // 5. R2: every DB reference exists with matching bytes; every backed-up object restored.
  const hashes = await hashAllObjects(bucket);
  const references = checkReferences(await referencedObjects(db), hashes);
  checks.push(check("r2_references", "数据库引用的对象都存在且 sha256 一致", references.missing.length + references.mismatched.length,
    `${references.referenced} 个引用`, [...references.missing.map((item) => `missing ${item.kind} ${item.key}`), ...references.mismatched.map((item) => `sha256 ${item.kind} ${item.key}`)]));
  const objectIssues = [];
  for (const object of manifest.r2.objects) {
    const actual = hashes.get(object.key);
    if (actual === undefined) objectIssues.push(`missing ${object.key}`);
    else if (actual !== object.sha256) objectIssues.push(`sha256 ${object.key}`);
  }
  const restoredKeys = new Set(manifest.r2.objects.map((item) => item.key));
  for (const key of hashes.keys()) if (!restoredKeys.has(key)) objectIssues.push(`unexpected ${key}`);
  checks.push(check("r2_objects", "R2 对象与清单一致", objectIssues.length, `${manifest.r2.objects.length} 个对象`, objectIssues));

  // 6. Credentials: no restored session or runner token hash can authenticate.
  if (invalidated) {
    const issues = [];
    const old = backupDir ? await backedUpTokenHashes(backupDir, manifest) : null;
    if (tables.has("app_sessions")) {
      for (const row of (await db.prepare("SELECT token_hash FROM app_sessions").all()).results) {
        if (!old || old.sessions.has(row.token_hash)) issues.push("app_sessions: a restored session row is still present");
      }
    }
    if (tables.has("lab_runners")) {
      for (const row of (await db.prepare("SELECT id, status, token_sha256 FROM lab_runners").all()).results) {
        if (old ? old.runners.has(row.token_sha256) : row.status !== "disabled") issues.push(`runner ${row.id} keeps its pre-restore token`);
      }
    }
    if (tables.has("local_credentials")) {
      const n = Number((await db.prepare("SELECT COUNT(*) AS n FROM local_credentials WHERE activation_hash IS NOT NULL").first()).n);
      if (n) issues.push(`local_credentials: ${n} activation hashes`);
    }
    checks.push(check("credentials_invalidated", "恢复前的会话、执行器令牌、激活码全部失效", issues.length, "", issues));
  }

  return {
    ok: checks.every((item) => item.status === "pass"),
    checks,
    stats: { referencedObjects: references.referenced, completeChains: chains },
  };
}

async function backedUpTokenHashes(backupDir, manifest) {
  const column = async (table, name) => {
    const entry = manifest.d1.tables[table];
    if (!entry) return new Set();
    const { columns, rows } = await readTableFile(backupDir, entry);
    const index = columns.indexOf(name);
    return new Set(rows.map((row) => row[index]).filter((value) => typeof value === "string"));
  };
  return { sessions: await column("app_sessions", "token_hash"), runners: await column("lab_runners", "token_sha256") };
}

// ---------------------------------------------------------------------------
// Production hand-off: SQL for `wrangler d1 execute --remote --file` and an
// R2 directory tree for `rclone copy`.
// ---------------------------------------------------------------------------
/**
 * Writes `d1-restore.sql` (schema + data + indexes/triggers, one statement per
 * line, FKs deferred) and `d1-sequences.sql` (AUTOINCREMENT counters, applied
 * separately because hosted D1 may refuse sqlite_sequence writes).
 */
export async function emitSql(db, outDir) {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const objects = await schemaObjects(db);
  const tables = objects.filter((row) => row.type === "table").map((row) => row.name);
  const oneLine = (sql) => sql.replace(/\s*\r?\n\s*/g, " ");
  const lines = ["PRAGMA defer_foreign_keys = TRUE;"];
  for (const object of objects.filter((row) => row.type === "table")) lines.push(`${oneLine(object.sql)};`);
  const columnsMap = await tableColumnsMap(db, tables);
  const allRows = await readAllRows(db, tables, columnsMap);
  for (const table of await insertOrder(db, tables)) {
    const prefix = `INSERT INTO ${q(table)} (${columnsMap.get(table).map(q).join(", ")}) VALUES (`;
    for (const row of allRows.get(table)) lines.push(`${prefix}${row.map(cellLiteral).join(", ")});`);
  }
  for (const type of ["index", "trigger", "view"]) {
    for (const object of objects.filter((row) => row.type === type)) lines.push(`${oneLine(object.sql)};`);
  }
  const sequences = (await readSequences(db)).map(({ name, seq }) =>
    `INSERT OR REPLACE INTO sqlite_sequence (rowid, name, seq) VALUES ((SELECT rowid FROM sqlite_sequence WHERE name = ${cellLiteral(name)}), ${cellLiteral(name)}, ${seq});`);
  const restoreFile = path.join(outDir, "d1-restore.sql");
  const sequencesFile = path.join(outDir, "d1-sequences.sql");
  await writeFile(restoreFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  await writeFile(sequencesFile, `${sequences.join("\n")}\n`, { mode: 0o600 });
  return { restoreFile, sequencesFile, statements: lines.length };
}

/** Writes every object to `<outDir>/<key>` (keys validated) plus an index TSV. */
export async function emitR2Tree(bucket, outDir) {
  const root = path.resolve(outDir);
  const index = ["key\tsha256\tsize\tcontent_type"];
  for (const object of await listAllObjects(bucket)) {
    const segments = object.key.split("/");
    if (!object.key || object.key.startsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`R2 key cannot be written as a path safely: ${JSON.stringify(object.key)}`);
    }
    const file = path.resolve(root, ...segments);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error(`R2 key escapes the output directory: ${object.key}`);
    const bytes = await objectBytes(bucket, object.key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o600 });
    index.push([object.key, sha256(bytes), bytes.length, object.httpMetadata?.contentType ?? ""].join("\t"));
  }
  await writeFile(path.join(path.dirname(root), `${path.basename(root)}.index.tsv`), `${index.join("\n")}\n`, { mode: 0o600 });
  return { objects: index.length - 1 };
}

/** Reads a directory tree (e.g. `rclone copy r2:<bucket> dir`) into a bucket; keys = relative paths. */
export async function importR2Tree(bucket, dir) {
  const root = path.resolve(dir);
  let count = 0;
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    const key = path.relative(root, file).split(path.sep).join("/");
    await bucket.put(key, await readFile(file));
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// SQL dump loading (`wrangler d1 export` output or d1-restore.sql)
// ---------------------------------------------------------------------------
const stripLeadingComments = (sql) => sql.replace(/^(?:\s*--[^\n]*(?:\n|$)|\s*\/\*[\s\S]*?\*\/)*/, "").trim();

/** Splits SQL text into statements; respects quotes, comments and trigger bodies. */
export function splitSqlStatements(text) {
  const statements = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === "\"" || char === "`") {
      index += 1;
      while (index < text.length) {
        if (text[index] === char) {
          if (text[index + 1] === char) { index += 2; continue; }
          break;
        }
        index += 1;
      }
    } else if (char === "[") {
      const close = text.indexOf("]", index);
      index = close < 0 ? text.length : close;
    } else if (char === "-" && text[index + 1] === "-") {
      const newline = text.indexOf("\n", index);
      index = newline < 0 ? text.length : newline;
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close < 0 ? text.length : close + 1;
    } else if (char === ";") {
      const statement = stripLeadingComments(text.slice(start, index));
      // A trigger body contains `;` — keep reading until its closing END.
      if (!/^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(statement) || /\bEND$/i.test(statement)) {
        if (statement) statements.push(statement);
        start = index + 1;
      }
    }
    index += 1;
  }
  const tail = stripLeadingComments(text.slice(start));
  if (tail) statements.push(tail);
  return statements;
}

const INSERT_TARGET = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/i;

/**
 * Loads a SQL dump into an EMPTY database in a safe order: every CREATE TABLE
 * first, then rows parent-first with FK checks deferred, then sequences, then
 * indexes, triggers and views. `wrangler d1 export` writes a child table's rows
 * before its parent table exists (sqlite_master order), which a plain
 * `wrangler d1 execute --file` replay rejects; this loader does not.
 */
export async function loadSqlDump(db, text) {
  const tables = [];
  const rows = new Map();
  const sequences = [];
  const late = [];
  for (const statement of splitSqlStatements(text)) {
    // Planner statistics (ANALYZE / sqlite_stat1) are rebuilt by SQLite, not restored.
    if (/^(?:PRAGMA|BEGIN|COMMIT|ANALYZE)\b/i.test(statement)) continue;
    if (/^DELETE\s+FROM\s+["`]?sqlite_sequence["`]?\s*$/i.test(statement)) continue;
    if (/^CREATE\s+TABLE\b/i.test(statement)) {
      if (/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(?:sqlite_|_cf_)/i.test(statement)) continue;
      tables.push(statement);
      continue;
    }
    const insert = INSERT_TARGET.exec(statement);
    if (insert) {
      const table = (insert[1]?.replaceAll("\"\"", "\"") ?? insert[2] ?? insert[3] ?? insert[4]);
      if (table.toLowerCase() === "sqlite_sequence") { sequences.push(statement); continue; }
      if (/^(?:_cf_|sqlite_)/i.test(table)) continue;
      if (!rows.has(table)) rows.set(table, []);
      rows.get(table).push(statement);
      continue;
    }
    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b|^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b|^CREATE\s+VIEW\b/i.test(statement)) {
      late.push(statement);
      continue;
    }
    throw new Error(`Unsupported statement in SQL dump: ${statement.slice(0, 80)}`);
  }
  if ((await listUserTables(db)).length) throw new RestoreRefusedError("SQL dumps load only into an empty database");
  await batchAll(db, tables.map((sql) => db.prepare(sql)));
  await db.prepare("PRAGMA foreign_keys = OFF").run().catch(() => undefined);
  const created = await listUserTables(db);
  const order = [...await insertOrder(db, created), ...[...rows.keys()].filter((table) => !created.includes(table))];
  let loaded = 0;
  for (const table of order) {
    const statements = rows.get(table) ?? [];
    for (let start = 0; start < statements.length; start += 200) {
      await db.batch([db.prepare("PRAGMA defer_foreign_keys = ON"), ...statements.slice(start, start + 200).map((sql) => db.prepare(sql))]);
    }
    loaded += statements.length;
  }
  if (sequences.length) {
    await batchAll(db, [db.prepare("DELETE FROM sqlite_sequence"), ...sequences.map((sql) => db.prepare(sql))]);
  }
  await batchAll(db, late.map((sql) => db.prepare(sql)));
  await db.prepare("PRAGMA foreign_keys = ON").run().catch(() => undefined);
  return { tables: tables.length, rows: loaded, sequences: sequences.length, indexesTriggersViews: late.length };
}

/** Human-readable verification summary. */
export function formatReport(verification) {
  return verification.checks.map((item) => `${item.status === "pass" ? "PASS" : "FAIL"}  ${item.id}  ${item.label}${item.detail ? `（${item.detail}）` : ""}`
    + (item.status === "pass" ? "" : `\n      ${item.samples.join("\n      ")}`)).join("\n");
}
