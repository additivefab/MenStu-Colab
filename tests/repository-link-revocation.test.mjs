import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import { changeStudentRepository, unlinkStudentRepository } from "../lib/student-repository.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Audit F-05: students may repoint their own binding, so a superadmin-verified
// GitHub identity must be revoked when the binding moves to another repository.
test("binding changes revoke the verified repository link unless the repository is unchanged", { timeout: 60_000 }, async () => {
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('') } }", d1Databases: { DB: "link-revocation" } });
  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES ('s1', '测试', '博士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES (1, 'local:s1', '测试', 'student', 's1')`).run();
    await db.prepare(`INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (7, 'lab', 'Organization')`).run();
    const input = (name, visibility = "private") => ({ githubUsername: "stu", repositoryUrl: `https://github.com/lab/${name}`, repositoryFullName: `lab/${name}`, visibility });
    const link = () => db.prepare("SELECT status FROM repository_links WHERE student_id = 's1'").first();
    const state = await changeStudentRepository(db, { studentId: "s1", actorUserId: 1, expectedVersion: 0, input: input("study") });
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch) VALUES ('s1', 42, 7, 'lab/Study', 'main')`).run();

    const same = await changeStudentRepository(db, { studentId: "s1", actorUserId: 1, expectedVersion: state.currentVersion, input: input("study", "unknown") });
    assert.equal((await link()).status, "active", "same repository (case-insensitive) keeps the verified link");

    await assert.rejects(changeStudentRepository(db, { studentId: "s1", actorUserId: 1, expectedVersion: state.currentVersion, input: input("other") }));
    assert.equal((await link()).status, "active", "a stale CAS must not revoke the link");

    const moved = await changeStudentRepository(db, { studentId: "s1", actorUserId: 1, expectedVersion: same.currentVersion, input: input("other") });
    assert.equal((await link()).status, "revoked", "repointing to another repository revokes the link");

    await db.prepare("UPDATE repository_links SET status = 'active', full_name = 'lab/other' WHERE student_id = 's1'").run();
    await unlinkStudentRepository(db, { studentId: "s1", actorUserId: 1, expectedVersion: moved.currentVersion });
    assert.equal((await link()).status, "revoked", "unlinking revokes the link");
  } finally { await mf.dispose(); }
});
