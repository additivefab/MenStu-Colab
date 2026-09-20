export const localAuthSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS local_credentials (
    app_user_id INTEGER PRIMARY KEY REFERENCES app_users(id),
    student_id TEXT NOT NULL REFERENCES students(id),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
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
