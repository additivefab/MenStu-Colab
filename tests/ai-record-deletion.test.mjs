import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import ts from 'typescript';
import { aiRecordChangeStatements, aiRecordCondition, createProgressDeletionsSql, protectDeletedProgressSql } from '../lib/ai-record-deletion.ts';
import { latestSubmittedSql, outstandingProgressSql, substantiveProgressSql } from '../lib/dashboard-overview/query-sql.ts';

const directory = new URL('../drizzle/', import.meta.url);
const migrations = await Promise.all((await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
  .map((name) => readFile(new URL(name, directory), 'utf8')));

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of migrations) db.exec(sql);
  db.exec(`INSERT INTO students (id, display_name, degree, grade_year, stage) VALUES
    ('a', '学生甲', '硕士', 2025, '实验'), ('b', '学生乙', '硕士', 2025, '实验');
    INSERT INTO app_users (id, feishu_open_id, display_name, role, student_id) VALUES
    (1, 'super', '超级管理员', 'superadmin', NULL), (2, 'admin', '管理员', 'admin', NULL),
    (3, 'other', '其他管理员', 'admin', NULL), (4, 'student', '学生甲', 'student', NULL),
    (5, 'reader', '只读导师', 'admin', NULL), (6, 'self', '双身份账号', 'admin', 'a');
    INSERT INTO mentor_student_assignments (mentor_user_id, student_id, can_review) VALUES
    (2, 'a', 1), (3, 'b', 1), (5, 'a', 0), (6, 'a', 1);
    INSERT INTO feishu_meeting_summary_imports (id, event_id, message_id, chat_id, raw_content, extracted_text, message_created_at, status)
    VALUES (1, 'meeting-event', 'meeting-message', '', '', '甲乙共同参加组会', '2026-09-07', 'confirmed');`);
  function progress(id, student, date, accepted, ai = true) {
    const state = accepted ? 'accepted' : 'submitted';
    db.prepare(`INSERT INTO progress_entries (id, student_id, kind, title, summary, submitted_at, status, review_status, assessment)
      VALUES (?, ?, ?, ?, '保留原始内容', ?, ?, ?, ?)`)
      .run(id, student, ai ? '组会' : '实验', `记录 ${id}`, date, accepted ? 'substantive' : 'pending', state, accepted ? 'substantive' : null);
    db.prepare(`INSERT INTO progress_revisions (progress_entry_id, revision_number, snapshot_json, review_status, assessment, reviewed_at)
      VALUES (?, 1, '{}', ?, ?, ?)`)
      .run(id, state, accepted ? 'substantive' : null, accepted ? date : null);
    if (ai) db.prepare(`INSERT INTO progress_evidence_sources (progress_entry_id, source_type, label, source_import_id)
      VALUES (?, 'feishu_minutes', '飞书妙记', 1)`).run(id);
  }
  progress(10, 'a', '2026-09-01', true);
  progress(11, 'a', '2026-09-07', true);
  progress(12, 'a', '2026-09-08', false);
  progress(13, 'b', '2026-09-07', true);
  progress(14, 'a', '2026-09-05', true, false);
  db.exec(`INSERT INTO feishu_meeting_summary_links (import_id, student_id, progress_entry_id)
    VALUES (1, 'a', 11), (1, 'b', 13);
    UPDATE students SET last_substantive_at = '2026-09-07';`);
  return db;
}

function change(db, overrides = {}) {
  const input = { progressId: 11, revision: 1, reviewStatus: 'accepted', actorId: 2, role: 'admin',
    ownStudentId: null, action: 'delete', operationId: crypto.randomUUID(), ...overrides };
  const statements = aiRecordChangeStatements(input);
  db.exec('BEGIN');
  try {
    const results = statements.map(({ sql, bindings }) => db.prepare(sql).run(...bindings));
    db.exec('COMMIT');
    return results;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

test('an assigned admin can delete and restore AI progress without losing revisions, imports or another student’s record', (t) => {
  const db = fixture(t);
  assert.equal(change(db, { operationId: 'delete-1' })[0].changes, 1);
  assert.equal(db.prepare('SELECT summary FROM progress_entries WHERE id = 11').get().summary, '保留原始内容');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress_revisions WHERE progress_entry_id = 11').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feishu_meeting_summary_links WHERE import_id = 1').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress_deletions WHERE progress_entry_id = 13').get().n, 0);
  assert.equal(db.prepare("SELECT extracted_text FROM feishu_meeting_summary_imports WHERE id = 1").get().extracted_text, '甲乙共同参加组会');
  assert.equal(db.prepare("SELECT last_substantive_at FROM students WHERE id = 'a'").get().last_substantive_at, '2026-09-05');
  assert.ok(!db.prepare(substantiveProgressSql(1)).all('a').some((row) => row.id === 11));
  assert.equal(change(db, { action: 'restore', deletionId: 'delete-1' })[0].changes, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress_deletions').get().n, 0);
  assert.equal(db.prepare("SELECT last_substantive_at FROM students WHERE id = 'a'").get().last_substantive_at, '2026-09-07');
  assert.ok(db.prepare(substantiveProgressSql(1)).all('a').some((row) => row.id === 11));
  assert.deepEqual(db.prepare('SELECT action FROM progress_audit_events WHERE progress_entry_id = 11 ORDER BY id').all()
    .map((row) => row.action), ['ai_record_deleted', 'ai_record_restored']);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('deleted pending AI entries leave the inbox and latest-submission statistics', (t) => {
  const db = fixture(t);
  assert.ok(db.prepare(outstandingProgressSql(1)).all('a').some((row) => row.id === 12));
  change(db, { progressId: 12, reviewStatus: 'submitted' });
  assert.ok(!db.prepare(outstandingProgressSql(1)).all('a').some((row) => row.id === 12));
  assert.ok(!db.prepare(latestSubmittedSql(1)).all('a').some((row) => row.id === 12));
});

test('student, unrelated, read-only, inactive and self-assigned accounts cannot delete or restore records', (t) => {
  const db = fixture(t);
  assert.throws(() => change(db, { actorId: 4, role: 'student', ownStudentId: 'a' }), /无权/);
  for (const override of [{ actorId: 3 }, { actorId: 5 }, { actorId: 6, ownStudentId: 'a' }, { actorId: 6 }]) {
    assert.equal(change(db, override)[0].changes, 0);
  }
  db.exec('UPDATE app_users SET active = 0 WHERE id = 2');
  assert.equal(change(db)[0].changes, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress_deletions').get().n, 0);
  change(db, { actorId: 1, role: 'superadmin', operationId: 'super-delete' });
  assert.equal(change(db, { actorId: 3, action: 'restore', deletionId: 'super-delete' })[0].changes, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress_deletions').get().n, 1);
});

test('stale revisions, changed review decisions and non-AI entries are rejected; repeated requests do not duplicate audit events', (t) => {
  const db = fixture(t);
  for (const override of [{ revision: 2 }, { reviewStatus: 'submitted' }, { progressId: 14 }]) {
    assert.equal(change(db, override)[0].changes, 0);
  }
  assert.equal(change(db, { operationId: 'once' })[0].changes, 1);
  assert.equal(change(db)[0].changes, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress_audit_events').get().n, 1);
  assert.equal(change(db, { action: 'restore', deletionId: 'wrong-deletion' })[0].changes, 0);
  assert.equal(change(db, { action: 'restore', deletionId: 'once' })[0].changes, 1);
  assert.equal(change(db, { action: 'restore', deletionId: 'once' })[0].changes, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress_audit_events').get().n, 2);
});

test('an in-flight review rolls back in full when the AI record has been deleted', (t) => {
  const db = fixture(t);
  change(db, { progressId: 12, reviewStatus: 'submitted', operationId: 'pending-delete' });
  db.exec('BEGIN');
  assert.throws(() => db.exec(`UPDATE progress_revisions SET review_status = 'accepted' WHERE progress_entry_id = 12;
    UPDATE progress_entries SET review_status = 'accepted' WHERE id = 12;`), /AI_RECORD_DELETED/);
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT review_status FROM progress_revisions WHERE progress_entry_id = 12').get().review_status, 'submitted');
  change(db, { progressId: 12, reviewStatus: 'submitted', action: 'restore', deletionId: 'pending-delete' });
  assert.doesNotThrow(() => db.exec("UPDATE progress_entries SET review_status = 'in_review' WHERE id = 12"));
});

test('runtime migration and generated migration expose the same deletion schema and guard', (t) => {
  const db = fixture(t);
  assert.doesNotThrow(() => db.exec(`${createProgressDeletionsSql}; ${protectDeletedProgressSql};`));
  assert.deepEqual(db.prepare('PRAGMA table_info(progress_deletions)').all().map((column) => column.name),
    ['progress_entry_id', 'deleted_by_user_id', 'deleted_at', 'operation_id']);
  assert.equal(db.prepare('SELECT version FROM app_schema_meta WHERE id = 1').get().version, 20);
});

test('HTTP handlers enforce administrator scope, origin, revision checks, private trash access and idempotent recovery', async (t) => {
  const db = fixture(t);
  let user = { id: 2, role: 'admin', primaryRole: 'admin', studentId: null };
  const adapter = {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return db.prepare(sql).get(...bindings) ?? null; },
        async all() { return { results: db.prepare(sql).all(...bindings) }; },
        async run() { return { meta: db.prepare(sql).run(...bindings) }; },
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const key = `ai_record_test_${crypto.randomUUID().replaceAll('-', '')}`;
  globalThis[key] = {
    aiRecordChangeStatements, aiRecordCondition,
    async ensureDatabase() {},
    getD1: () => adapter,
    assertSameOrigin: (request) => request.headers.get('Origin') === new URL(request.url).origin,
    async requireAppUser(_request, roles) {
      return roles.includes(user.role) ? { user } : { response: Response.json({ error: '无权访问' }, { status: 403 }) };
    },
    async canReviewStudent(actor, studentId) {
      if (actor.studentId === studentId || !['admin', 'superadmin'].includes(actor.role)) return false;
      return actor.role === 'superadmin' || Boolean(db.prepare(`SELECT 1 FROM mentor_student_assignments
        WHERE mentor_user_id = ? AND student_id = ? AND active = 1 AND can_review = 1`).get(actor.id, studentId));
    },
    async canViewStudent(actor, studentId) {
      if (actor.role === 'student') return actor.studentId === studentId;
      return actor.role === 'superadmin' || Boolean(db.prepare(`SELECT 1 FROM mentor_student_assignments
        WHERE mentor_user_id = ? AND student_id = ? AND active = 1`).get(actor.id, studentId));
    },
  };
  t.after(() => { delete globalThis[key]; });
  async function routeModule(path) {
    const source = (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
    const code = ts.transpileModule(`const { ${Object.keys(globalThis[key]).join(', ')} } = globalThis['${key}'];\n${source}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  }
  const route = await routeModule('../app/api/ai-records/route.ts');
  const guidance = await routeModule('../app/api/student-guidance/route.ts');
  const body = { progressId: 11, revision: 1, reviewStatus: 'accepted' };
  function request(method, payload = body, origin = 'https://school.test') {
    return new Request('https://school.test/api/ai-records?studentId=a', { method,
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }) });
  }
  assert.equal((await route.DELETE(request('DELETE', body, 'https://outside.test'))).status, 403);
  assert.equal((await route.DELETE(request('DELETE', null))).status, 400);
  assert.equal((await route.DELETE(request('DELETE', { ...body, revision: 2 }))).status, 409);
  user = { id: 3, role: 'admin', studentId: null };
  assert.equal((await route.DELETE(request('DELETE'))).status, 403);
  assert.equal((await route.GET(request('GET'))).status, 403);
  user = { id: 6, role: 'student', primaryRole: 'admin', studentId: 'a' };
  assert.equal((await route.DELETE(request('DELETE'))).status, 403);
  assert.equal((await route.GET(request('GET'))).status, 403);
  user = { id: 2, role: 'admin', studentId: null };
  assert.equal((await route.DELETE(request('DELETE'))).status, 200);
  assert.equal((await route.DELETE(request('DELETE'))).status, 200);
  const trashResponse = await route.GET(request('GET'));
  assert.equal(trashResponse.headers.get('Cache-Control'), 'private, no-store');
  const trash = await trashResponse.json();
  assert.deepEqual(trash.records.map((record) => record.id), [11]);
  const workspaceRequest = new Request('https://school.test/api/student-guidance?studentId=a');
  assert.deepEqual((await (await guidance.GET(workspaceRequest)).json()).meetingSummaries, []);
  user = { id: 4, role: 'student', studentId: 'a' };
  const studentWorkspace = await (await guidance.GET(workspaceRequest)).json();
  assert.deepEqual(studentWorkspace.meetingSummaries, []);
  assert.equal(studentWorkspace.canManageAiRecords, false);
  user = { id: 2, role: 'admin', studentId: null };
  assert.equal((await route.PATCH(request('PATCH', { ...body, deletionId: 'outdated' }))).status, 409);
  const restoreBody = { ...body, deletionId: trash.records[0].deletion_id };
  assert.equal((await route.PATCH(request('PATCH', restoreBody))).status, 200);
  assert.equal((await route.PATCH(request('PATCH', restoreBody))).status, 200);
  const restored = await (await guidance.GET(workspaceRequest)).json();
  assert.equal(restored.meetingSummaries[0].progress_entry_id, 11);
  assert.equal(restored.meetingSummaries[0].current_revision, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM progress_audit_events').get().n, 2);
});
