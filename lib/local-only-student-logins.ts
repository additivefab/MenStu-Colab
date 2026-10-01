import { hashInitialPassword } from "./local-password.ts";

// Owner-confirmed existing records without an app account, requested 2026-09-29 and 2026-10-01.
// local: IDs are local-only identifiers, never verified Feishu identities.
const students = [
  { id: "student-005", name: "Muhammad Jalil Ur Rehman", username: "mjur", rolloutKey: "local-only-students-20260929:student-005" },
  { id: "student-006", name: "Abbasi", username: "abbasi", rolloutKey: "local-only-students-20260929:student-006" },
  { id: "student-026", name: "钟昊航", username: "zhh", rolloutKey: "local-only-students-20261001:student-026" },
] as const;

const eligible = `s.id = ? AND s.display_name = ? AND s.active = 1
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key = ?)
  AND NOT EXISTS (SELECT 1 FROM app_users WHERE student_id = s.id OR feishu_open_id = ?)
  AND NOT EXISTS (SELECT 1 FROM local_credentials WHERE student_id = s.id OR username = ?)
  AND NOT EXISTS (SELECT 1 FROM student_feishu_identity_bindings WHERE student_id = s.id)`;

export async function provisionLocalOnlyStudentLogins(d1: D1Database) {
  const statements: D1PreparedStatement[] = [];
  for (const student of students) {
    const openId = `local:${student.id}`;
    const rollout = student.rolloutKey;
    const bindings = [student.id, student.name, rollout, openId, student.username];
    // Skip hashing on subsequent cold starts; repeat all guards inside the transaction.
    if (!await d1.prepare(`SELECT s.id FROM students s WHERE ${eligible}`).bind(...bindings).first()) continue;
    const passwordHash = await hashInitialPassword();
    statements.push(
      d1.prepare(`INSERT INTO app_users (feishu_open_id, display_name, role, student_id, active)
        SELECT ?, s.display_name, 'student', s.id, 1 FROM students s WHERE ${eligible}`)
        .bind(openId, ...bindings),
      // changes() binds credential issuance to the immediately preceding new user insert.
      d1.prepare(`INSERT INTO local_credentials
        (app_user_id, student_id, username, password_hash, must_change_password)
        SELECT id, student_id, ?, ?, 1 FROM app_users
        WHERE changes() > 0 AND feishu_open_id = ? AND student_id = ? AND role = 'student' AND active = 1`)
        .bind(student.username, passwordHash, openId, student.id),
      d1.prepare(`INSERT INTO local_login_rollouts (rollout_key) SELECT ? WHERE changes() > 0`).bind(rollout),
    );
  }
  // Atomic, insert-only, and durable across concurrent Workers and later deployments.
  if (statements.length) await d1.batch(statements);
}
