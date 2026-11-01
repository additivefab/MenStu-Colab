import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  changeStudentRepository, unlinkStudentRepository, readStudentRepository,
  normalizeGithubRepositoryUrl, normalizeGithubUsername, parseStudentRepositoryInput,
  RepositoryInputError, RepositoryConflictError,
} from "../lib/student-repository.ts";
import {
  CONFIRMED_REPOSITORY_ROLLOUT_KEY, provisionConfirmedRepositoryBindings,
} from "../lib/confirmed-repository-bindings.ts";

const directory = new URL("../drizzle/", import.meta.url);
const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const migrations = await Promise.all(names.map((name) => readFile(new URL(name, directory), "utf8")));

function adapter(db) {
  return {
    prepare(sql) {
      let bindings = [];
      const execute = () => {
        const statement = db.prepare(sql);
        const results = statement.columns().length ? statement.all(...bindings).map((row) => ({ ...row })) : [];
        if (!statement.columns().length) statement.run(...bindings);
        return { results, success: true, meta: { changes: Number(db.prepare("SELECT changes() AS n").get().n) } };
      };
      return {
        bind(...values) { bindings = values; return this; },
        async first() { return db.prepare(sql).get(...bindings) ?? null; },
        async all() { return execute(); },
        async run() { return execute(); },
        execute,
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try { const result = statements.map((statement) => statement.execute()); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}

function fixture(t, { through = "9999_" } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrations.forEach((sql, index) => { if (names[index] < through) db.exec(sql); });
  t.after(() => db.close());
  return { db, d1: adapter(db) };
}

function seedStudent(db, { id = "student-010", name = "邵华阳", active = 1 } = {}) {
  db.prepare("INSERT INTO students(id,display_name,degree,grade_year,stage,active) VALUES (?,?,'博士',2025,'实验',?)").run(id, name, active);
}

test("repository parser canonicalizes clone URLs and accepts only an unambiguous GitHub repository", () => {
  assert.equal(normalizeGithubUsername(" lih62876-ui "), "lih62876-ui");
  assert.deepEqual(normalizeGithubRepositoryUrl(" HTTPS://GITHUB.COM/tanyan-research-lab/shaohuayang-research.git/ "), {
    repositoryUrl: "https://github.com/tanyan-research-lab/shaohuayang-research",
    repositoryFullName: "tanyan-research-lab/shaohuayang-research",
  });
  const base = { studentId: "student-010", githubUsername: "lih62876-ui", repositoryUrl: "https://github.com/tanyan-research-lab/shaohuayang-research", visibility: "private", expectedVersion: 0 };
  assert.equal(parseStudentRepositoryInput(base).visibility, "private");
  for (const repositoryUrl of [
    "javascript:alert(1)", "https://github.com.evil.example/lab/repo", "https://github.com@evil.example/lab/repo",
    "https://secret@github.com/lab/repo", "https://github.com:443/lab/repo", "https://github.com/lab/repo?x=1",
    "https://github.com/lab/repo#readme", "https://github.com/lab/repo/tree/main", "https://github.com/lab/repo/commit/123",
    "https://github.com/lab/%72epo", "https://github.com/lab/..", "https://github.com/lab/.git",
    "https://github.com/lab/../repo", "https://github.com/lab/%2e%2e/repo", "https://github.com/lab\\repo",
    "https://github.com/lab/re\tpo", "https://github.com/lab/re\npo", "https://github.com/lab/reро", "https://github.com/lab/" + "r".repeat(101),
  ]) assert.throws(() => parseStudentRepositoryInput({ ...base, repositoryUrl }), RepositoryInputError, repositoryUrl);
  for (const githubUsername of [null, {}, "", "@lih62876-ui", "a_b", "a--b", "-abc", "abc-", "a".repeat(40)]) {
    assert.throws(() => parseStudentRepositoryInput({ ...base, githubUsername }), RepositoryInputError);
  }
  for (const expectedVersion of [null, undefined, "0", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseStudentRepositoryInput({ ...base, expectedVersion }), RepositoryInputError);
  }
});

test("the new deployment migration adds repository storage without changing existing student work or seeding data", (t) => {
  const { db } = fixture(t, { through: "0025_" });
  seedStudent(db);
  db.exec(`INSERT INTO app_users(id,feishu_open_id,display_name,role) VALUES(991,'repository-migration-owner','测试导师','superadmin');
    INSERT INTO progress_entries(student_id,kind,title,status,review_status,assessment,submitted_by_user_id)
      VALUES('student-010','项目','历史成果','substantive','accepted','substantive',991);
    INSERT INTO student_guidance_notes(student_id,mentor_user_id,title,content,next_action,due_date)
      VALUES('student-010',991,'后续实验','独立后续工作','测量新样本','2099-12-21');`);
  const before = ["students", "app_users", "progress_entries", "student_guidance_notes", "app_schema_meta"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  migrations.forEach((sql, index) => { if (names[index] >= "0025_") db.exec(sql); });
  assert.deepEqual(["students", "app_users", "progress_entries", "student_guidance_notes", "app_schema_meta"].map((table) => db.prepare(`SELECT * FROM ${table}`).all()), before);
  for (const table of ["student_repository_bindings", "student_repository_events", "student_repository_rollouts"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, "DDL cannot provision an owner-specific student binding");
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("confirmed provisioning matches the exact active student and survives concurrent calls, later edits and unlinking", async (t) => {
  const { db, d1 } = fixture(t);
  seedStudent(db);
  db.exec("INSERT INTO app_users(id,feishu_open_id,display_name,role) VALUES(991,'repo-fixture-owner','测试导师','superadmin')");
  const users = db.prepare("SELECT * FROM app_users").all();
  const students = db.prepare("SELECT * FROM students").all();
  await Promise.all([provisionConfirmedRepositoryBindings(d1), provisionConfirmedRepositoryBindings(d1)]);
  let state = await readStudentRepository(d1, "student-010");
  assert.equal(state.currentVersion, 1);
  assert.equal(state.binding.repositoryFullName, "tanyan-research-lab/shaohuayang-research");
  assert.equal(state.binding.githubUsername, "lih62876-ui");
  assert.equal(state.binding.visibility, "private");
  assert.equal(db.prepare("SELECT count(*) AS n FROM student_repository_events").get().n, 1);
  assert.equal(db.prepare("SELECT rollout_key FROM student_repository_rollouts").get().rollout_key, CONFIRMED_REPOSITORY_ROLLOUT_KEY);
  state = await changeStudentRepository(d1, { studentId: "student-010", actorUserId: 991, expectedVersion: 1, input: {
    githubUsername: "changed-user", repositoryUrl: "https://github.com/lab/changed", repositoryFullName: "lab/changed", visibility: "unknown",
  } });
  await provisionConfirmedRepositoryBindings(d1);
  assert.deepEqual(await readStudentRepository(d1, "student-010"), state);
  const unlinked = await unlinkStudentRepository(d1, { studentId: "student-010", actorUserId: 991, expectedVersion: 2 });
  assert.deepEqual(unlinked, { binding: null, currentVersion: 3 });
  await provisionConfirmedRepositoryBindings(d1);
  assert.deepEqual(await readStudentRepository(d1, "student-010"), unlinked);
  assert.deepEqual(db.prepare("SELECT * FROM app_users").all(), users);
  assert.deepEqual(db.prepare("SELECT * FROM students").all(), students);
  for (const table of ["progress_entries", "progress_revisions", "student_guidance_notes", "notification_deliveries"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
});

test("provisioning never overwrites an existing binding, including a previously unlinked row", async (t) => {
  for (const active of [0, 1]) {
    const { db, d1 } = fixture(t);
    seedStudent(db);
    db.prepare(`INSERT INTO student_repository_bindings(student_id,github_username,repository_url,repository_full_name,visibility,active,version,last_mutation_id)
      VALUES('student-010','existing-user','https://github.com/lab/existing','lab/existing','unknown',?,7,'existing-setting')`).run(active);
    const before = db.prepare("SELECT * FROM student_repository_bindings").all();
    await provisionConfirmedRepositoryBindings(d1);
    assert.deepEqual(db.prepare("SELECT * FROM student_repository_bindings").all(), before);
    assert.equal(db.prepare("SELECT count(*) AS n FROM student_repository_events").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM student_repository_rollouts").get().n, 1);
  }
});

test("provisioning skips a wrong ID, wrong name or inactive student and does not mark a missing target as applied", async (t) => {
  for (const row of [{ id: "different-id" }, { name: "同号其他学生" }, { active: 0 }]) {
    const { db, d1 } = fixture(t);
    seedStudent(db, row);
    await provisionConfirmedRepositoryBindings(d1);
    for (const table of ["student_repository_bindings", "student_repository_events", "student_repository_rollouts"]) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    }
  }
});

test("a stale mutation creates no audit, and an audit failure rolls back the binding atomically", async (t) => {
  const { db, d1 } = fixture(t);
  seedStudent(db);
  db.exec("INSERT INTO app_users(id,feishu_open_id,display_name,role) VALUES(991,'repo-atomic-owner','测试导师','superadmin')");
  const change = { studentId: "student-010", actorUserId: 991, expectedVersion: 0, input: {
    githubUsername: "fixture-user", repositoryUrl: "https://github.com/lab/study", repositoryFullName: "lab/study", visibility: "private",
  } };
  await changeStudentRepository(d1, change);
  await assert.rejects(changeStudentRepository(d1, change), RepositoryConflictError);
  assert.equal(db.prepare("SELECT count(*) AS n FROM student_repository_events").get().n, 1);
  const before = db.prepare("SELECT * FROM student_repository_bindings").get();
  db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON student_repository_events BEGIN SELECT RAISE(ABORT, 'audit fixture failure'); END;");
  await assert.rejects(changeStudentRepository(d1, { ...change, expectedVersion: 1 }), /audit fixture failure/);
  assert.deepEqual(db.prepare("SELECT * FROM student_repository_bindings").get(), before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM student_repository_events").get().n, 1);
});
