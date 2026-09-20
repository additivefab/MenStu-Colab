// One-time account provisioning explicitly requested by the owner on 2026-09-20.
// Exact live user + student ID pairs were checked before rollout. Never match by name.
// Passwords are stored as independently salted hashes; existing credentials are preserved.
// The rollout marker prevents reactivation on later requests or Worker restarts.
export const initialStudentLoginStatements = [
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'why', 'scrypt:16384:8:5:5b01cb8006a9f31aa3c4bdfbafc4670c:c1928956a344bb7ac9c372663bc2bff405464c476594d0d26e215979228de6a2', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=2 AND u.student_id='student-001' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'shy', 'scrypt:16384:8:5:35338a62f39fd0dfd54a3bb2df75bfaa:6e3ecc5bb1b5b0bc38b3cf43b0a68a989819e87c144277a590ccb8018d982096', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=3 AND u.student_id='student-010' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'zxr', 'scrypt:16384:8:5:34362438efc2bc986822e66b9b3ca3cc:b6070948d0632b431676d71b4476637bae6fe33bc695d13f653a463605eddc00', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=4 AND u.student_id='student-022' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'lxb', 'scrypt:16384:8:5:083df2a697a72c861508d3e59512248d:44ce5868d6603a2d6d36a6109426548a30eaff148dd482bd7c2849c9ca2e5918', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=5 AND u.student_id='student-025' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'wsk', 'scrypt:16384:8:5:50e62a2a68c1df45203e3bdb1c02ddda:a561927a640e42913eb5e94591c5edb913917880b217dfaaa9cd39ca5b3c983d', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=6 AND u.student_id='student-017' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'qh', 'scrypt:16384:8:5:135d711c80384f51014a16b30f5cd82f:500e60815346690e9f4c143f9a3973e962c31edc94f63edca2a5dd776e1c5ff0', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=7 AND u.student_id='student-015' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'wjj', 'scrypt:16384:8:5:589192686fb26693d6c1e604112259e1:029abfa0d5dd541b40d7bcff446bf689b64c110c931952907bfd6acf6c4d0a54', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=8 AND u.student_id='student-023' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'fz', 'scrypt:16384:8:5:84bb1a899229a48f9a568afb4ea1ca5c:632d51a2e06d231eea60a5fda97b64f3a4972b642e9843d3cb0462d7c76db0ab', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=9 AND u.student_id='student-016' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'yrx', 'scrypt:16384:8:5:4469e8f81761a525951beebc124238df:a2998302b2d89f53ee96f40fd788a793d1ee3cf94adfc340eb7a394d90e491dd', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=10 AND u.student_id='student-012' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'cc', 'scrypt:16384:8:5:9c8b115b56b7b814ec82a93614b202eb:04528091ea3bc5328cdfa212ead9142c795db079db8ab093f75a4bc84db31d64', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=11 AND u.student_id='student-003' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'hyf', 'scrypt:16384:8:5:4fac9262937a6ade14c197dfbb744870:a0cc6293e2afb0f83791255001f01812171e3107c7d3d5bd458af19670d1a7de', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=12 AND u.student_id='student-004' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'hyh', 'scrypt:16384:8:5:7c52d52f6abee74ab85555f996a376ce:3e439dbebd55761d78d42603638c3f83551afbca7e598322d829bbd6dc809baa', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=13 AND u.student_id='student-014' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'cy', 'scrypt:16384:8:5:56b7fdd56aaa1174a01ac75de7ae4777:195f1396f13534656fbf95226e41b4043eb9518e266269e59a05b403d0adf9a4', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=14 AND u.student_id='student-021' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'mzn', 'scrypt:16384:8:5:c23ea13890a76deb21e8196600d77a80:ca45e895ebad86efd3493f4d060a3730f53dab657d596a21c0a5ef54d24c1622', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=15 AND u.student_id='student-020' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'szh', 'scrypt:16384:8:5:3baf69db5c8589b9f452e95c5e73b56f:8b712d3b4f939a867ca0b2296007959d1d2d3163c70b2983b842a85f31a52e56', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=16 AND u.student_id='student-008' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'lqy', 'scrypt:16384:8:5:dda361ae3a32ea93ce21bf1335580b2b:afbe8f5fbb49a3148c1c0633bce9b68c7cc4fdbd992283cf1fb931cd65ec5624', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=17 AND u.student_id='student-009' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'jf', 'scrypt:16384:8:5:246dbef19eb28f04a99867cb3053fde6:4ee987524d30d66faa6e169a87f2cbb46971f7a40d6de6a763f03387a4471e32', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=18 AND u.student_id='student-013' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'gy', 'scrypt:16384:8:5:cda5ecfd9a39e681a1ec699e9ff08765:9b168cfc0cd1b3b82b0d23ff265f9fa6fc5924009588bb328c8d10b9b05a5358', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=19 AND u.student_id='student-024' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'yc', 'scrypt:16384:8:5:bbfe42b3822a9997267660eaf94b94a9:5acca42320df1fac56c4fad36b388d79f60ac5c1a030eb43df55dc7644b8a7e9', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=20 AND u.student_id='student-019' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'lwj', 'scrypt:16384:8:5:b32078a04f43bb1172a7f3361f485198:50dedc1639ee863882f78a96223df69c7a178f1eaf48c2f0aee5d76074e04592', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=21 AND u.student_id='student-011' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'zyj', 'scrypt:16384:8:5:d56c792d486d99849727327128f4dc7c:28edd1afc971a12f1977108daaf2f14e21dc10fde7ea6dc29bba0777b3c231f1', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=22 AND u.student_id='student-018' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT INTO local_credentials (app_user_id, student_id, username, password_hash, must_change_password)
SELECT u.id, u.student_id, 'mn', 'scrypt:16384:8:5:1ff1037bde6e3dec15ff42342ac5b7ed:c8c88bcf8f354f85146d1ab237bcdbce72e417b23113f393d2a270c7767f4654', 1
FROM app_users u JOIN students s ON s.id=u.student_id
WHERE u.id=23 AND u.student_id='student-007' AND u.role='student' AND u.active=1 AND s.active=1
  AND NOT EXISTS (SELECT 1 FROM local_credentials c WHERE c.app_user_id=u.id)
  AND NOT EXISTS (SELECT 1 FROM local_login_rollouts WHERE rollout_key='initial-students-20260920')`,
  `INSERT OR IGNORE INTO local_login_rollouts (rollout_key) VALUES ('initial-students-20260920')`,
] as const;

export async function provisionInitialStudentLogins(d1: D1Database) {
  const applied = await d1.prepare("SELECT rollout_key FROM local_login_rollouts WHERE rollout_key = 'initial-students-20260920'").first();
  if (applied) return;
  await d1.batch(initialStudentLoginStatements.map(sql => d1.prepare(sql)));
}
