// Owner-authorized binding on 2026-11-01. The live student id and name were
// checked before rollout. This is data provisioning, separate from migrations.
// A durable rollout marker and existing-row guard preserve later edits/unlinks.
export const CONFIRMED_REPOSITORY_ROLLOUT_KEY = "shaohuayang-repository-20261101";

export const confirmedRepositoryBindingStatements = [
  `INSERT INTO student_repository_bindings
    (student_id, github_username, repository_url, repository_full_name, visibility, active, version, last_mutation_id)
    SELECT s.id, 'lih62876-ui', 'https://github.com/tanyan-research-lab/shaohuayang-research',
      'tanyan-research-lab/shaohuayang-research', 'private', 1, 1, 'shaohuayang-repository-20261101'
    FROM students s WHERE s.id = 'student-010' AND s.display_name = '邵华阳' AND s.active = 1
      AND NOT EXISTS (SELECT 1 FROM student_repository_rollouts WHERE rollout_key = 'shaohuayang-repository-20261101')
    ON CONFLICT(student_id) DO NOTHING`,
  `INSERT INTO student_repository_events (student_id, version, action, actor_type, snapshot_json)
    SELECT student_id, version, 'created', 'system', json_object(
      'githubUsername', github_username, 'repositoryUrl', repository_url,
      'repositoryFullName', repository_full_name, 'visibility', visibility, 'active', active,
      'reason', 'owner_authorized_2026-11-01')
    FROM student_repository_bindings b
    WHERE last_mutation_id = 'shaohuayang-repository-20261101'
      AND NOT EXISTS (SELECT 1 FROM student_repository_rollouts WHERE rollout_key = 'shaohuayang-repository-20261101')
      AND NOT EXISTS (SELECT 1 FROM student_repository_events e WHERE e.student_id = b.student_id AND e.version = b.version)`,
  `INSERT INTO student_repository_rollouts (rollout_key)
    SELECT 'shaohuayang-repository-20261101' FROM students s
    WHERE s.id = 'student-010' AND s.display_name = '邵华阳' AND s.active = 1
    ON CONFLICT(rollout_key) DO NOTHING`,
] as const;

export async function provisionConfirmedRepositoryBindings(d1: D1Database) {
  const applied = await d1.prepare("SELECT rollout_key FROM student_repository_rollouts WHERE rollout_key = ?")
    .bind(CONFIRMED_REPOSITORY_ROLLOUT_KEY).first();
  if (applied) return;
  await d1.batch(confirmedRepositoryBindingStatements.map((statement) => d1.prepare(statement)));
}
