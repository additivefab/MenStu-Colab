// Explicit owner request, 2026-09-29. Existing identities and roles are never changed.
// Only salted password hashes are stored. These accounts do not require a first-login reset.
const accounts = [
  { id: 1, name: "佘阳", studentId: "student-002", username: "sy", passwordHash: "scrypt:16384:8:5:c64111f5b790e1a8348087381a060bfe:e3c9a7847f72be02d0a38ee64d0b0707d2ec1d27be807bb70be1ec49550fa017" },
  { id: 24, name: "于兴华", studentId: null, username: "yxh", passwordHash: "scrypt:16384:8:5:375fbd174c96238d71cc6305bdc4a3c6:46aebf206c47fb1c8ddd22bca0a2022687bffff3722b57ed1ff3394501ec2485" },
] as const;

export async function provisionAdministratorLogins(d1: D1Database) {
  const statements: D1PreparedStatement[] = [];
  for (const account of accounts) {
    const rollout = `administrator-logins-20260929:${account.id}`;
    if (await d1.prepare("SELECT 1 FROM local_login_rollouts WHERE rollout_key = ?").bind(rollout).first()) continue;
    statements.push(
      d1.prepare(`INSERT INTO local_credentials
        (app_user_id, student_id, authorized_role, username, password_hash, must_change_password)
        SELECT u.id, u.student_id, u.role, ?, ?, 0 FROM app_users u
        WHERE u.id = ? AND u.display_name = ? AND u.student_id IS ? AND u.role = 'superadmin' AND u.active = 1
          AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key = ?)
          AND NOT EXISTS (SELECT 1 FROM local_credentials WHERE app_user_id = u.id OR username = ?)
          AND (u.student_id IS NULL OR EXISTS (SELECT 1 FROM students WHERE id = u.student_id AND active = 1))
          AND EXISTS (SELECT 1 FROM app_users owner WHERE owner.id = 1 AND owner.display_name = '佘阳'
            AND owner.role = 'superadmin' AND owner.active = 1)`)
        .bind(account.username, account.passwordHash, account.id, account.name, account.studentId, rollout, account.username),
      d1.prepare(`INSERT INTO local_auth_events (app_user_id, actor_user_id, action, request_id)
        SELECT ?, 1, 'issue', ? WHERE changes() > 0`).bind(account.id, rollout),
      d1.prepare("INSERT INTO local_login_rollouts (rollout_key) SELECT ? WHERE changes() > 0").bind(rollout),
    );
  }
  if (statements.length) await d1.batch(statements);
}
