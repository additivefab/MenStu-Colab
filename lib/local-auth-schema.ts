export const localAuthSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS local_login_rollouts (rollout_key TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS local_credentials (
    app_user_id INTEGER PRIMARY KEY REFERENCES app_users(id),
    student_id TEXT REFERENCES students(id),
    authorized_role TEXT NOT NULL DEFAULT 'student' CHECK (authorized_role IN ('student', 'admin', 'superadmin')),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    activation_hash TEXT UNIQUE,
    activation_expires_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS local_auth_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_user_id INTEGER NOT NULL REFERENCES app_users(id),
    actor_user_id INTEGER NOT NULL REFERENCES app_users(id),
    action TEXT NOT NULL CHECK (action IN ('issue', 'activate', 'disable', 'change_password')),
    request_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS local_auth_attempts (
    key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  )`,
] as const;

// Schema 24: preserve every credential and session while allowing accounts without a student profile.
export async function upgradeLocalCredentialsSchema(d1: D1Database) {
  const columns = await d1.prepare("PRAGMA table_info(local_credentials)").all<{ name: string; notnull: number }>();
  if (!columns.results.some(c => c.name === "authorized_role")) {
    try {
      await d1.prepare("ALTER TABLE local_credentials ADD COLUMN authorized_role TEXT NOT NULL DEFAULT 'student'").run();
    } catch (error) {
      const current = await d1.prepare("PRAGMA table_info(local_credentials)").all<{ name: string }>();
      if (!current.results.some(c => c.name === "authorized_role")) throw error;
    }
  }
  if (!columns.results.some(c => c.name === "student_id" && c.notnull === 1)) return;
  const fields = "app_user_id, student_id, authorized_role, username, password_hash, must_change_password, activation_hash, activation_expires_at, version, updated_at";
  await d1.batch([
    d1.prepare(localAuthSchemaStatements[1].replace("IF NOT EXISTS local_credentials", "local_credentials_v24")),
    // Copy authorized_role too: a concurrent upgrader may already have provisioned an administrator.
    d1.prepare(`INSERT INTO local_credentials_v24 (${fields}) SELECT ${fields} FROM local_credentials`),
    d1.prepare("DROP TABLE local_credentials"),
    d1.prepare("ALTER TABLE local_credentials_v24 RENAME TO local_credentials"),
  ]);
}
