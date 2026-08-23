import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("database initialization is version-gated and never seeds demonstration students", async () => {
  const [database, migration, health] = await Promise.all([
    readFile(new URL("../lib/database.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0016_dashing_union_jack.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/health/ready/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(database, /CURRENT_SCHEMA_VERSION = 16/);
  assert.match(database, /databaseReadyPromise \?\?=/);
  assert.match(database, /数据库结构不完整/);
  assert.match(database, /app_schema_meta/);
  assert.doesNotMatch(database, /demoStudents|demoProgress|博士生 01|master-03/);
  assert.match(migration, /INSERT INTO `app_schema_meta`/);
  assert.match(migration, /UPDATE `app_users` SET `email` = ''/);
  assert.match(health, /confirmedRoster/);
  assert.match(health, /student_feishu_identity_bindings/);
  assert.match(health, /mainland_networks/);
  assert.match(health, /backup_restore/);
  assert.doesNotMatch(health, /appId:/);
});

test("mentor guidance is delivered to the bound student and completion is audited", async () => {
  const [route, dashboard, overview, schema] = await Promise.all([
    readFile(new URL("../app/api/student-guidance/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/students/[id]/student-overview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(route, /requireAppUser\(request, \["superadmin", "admin", "student"\]\)/);
  assert.match(route, /auth\.user\.role === "student" \? auth\.user\.studentId/);
  assert.match(route, /学生账号只能读取本人的导师指导/);
  assert.match(route, /action === "acknowledge"/);
  assert.match(route, /只有学生本人可以确认收到导师指导/);
  assert.match(route, /action === "complete"/);
  assert.match(route, /学生不能重新打开已完成的导师指导/);
  assert.match(route, /INSERT INTO student_guidance_events/);
  assert.match(dashboard, /StudentGuidanceInbox/);
  assert.match(dashboard, /确认收到/);
  assert.match(dashboard, /完成说明（可选）/);
  assert.match(overview, /学生已于/);
  assert.match(schema, /studentGuidanceEvents/);
  assert.match(schema, /acknowledgedAt/);
  assert.match(schema, /completedByUserId/);
});

test("authentication responses expose only a public user DTO and no longer retain member email", async () => {
  const [auth, session, exchange, users, dashboard] = await Promise.all([
    readFile(new URL("../lib/feishu-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/session/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/feishu/exchange/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/users/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(auth, /export function publicAppUser/);
  assert.match(auth, /email = ''/);
  assert.doesNotMatch(auth, /info\.enterprise_email \?\?/);
  assert.match(session, /publicAppUser\(user\)/);
  assert.match(exchange, /publicAppUser\(session\.user\)/);
  assert.doesNotMatch(users, /u\.email/);
  assert.doesNotMatch(dashboard, /user\.email/);
});
