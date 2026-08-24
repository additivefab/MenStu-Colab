import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("persona switching is same-origin, HttpOnly, and re-authorized from the persisted account", async () => {
  const [auth, personaRoute, exchange, logout] = await Promise.all([
    readFile(new URL("../lib/feishu-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/persona/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/feishu/exchange/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/logout/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(auth, /mapUser\(row, readCookie\(request, PERSONA_COOKIE\)\)/);
  assert.match(auth, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(personaRoute, /assertSameOrigin\(request\)/);
  assert.match(personaRoute, /isAdminRole\(user\.primaryRole\)/);
  assert.match(personaRoute, /user\.studentId/);
  assert.match(exchange, /personaCookie\("management"\)/);
  assert.match(logout, /clearPersonaCookie\(\)/);
});

test("dual-persona student requests use the student role branch and self-review is denied", async () => {
  const [authorization, dashboard, progress, meetings, guidance, ui] = await Promise.all([
    readFile(new URL("../lib/authorization.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/progress/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/meeting-requests/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/student-guidance/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(authorization, /if \(isOwnStudentRecord\(user, studentId\)\) return false/);
  assert.match(dashboard, /studentId !== viewer\.studentId/);
  assert.match(progress, /请切换到本人学生端提交自己的进展/);
  assert.match(progress, /请切换到本人学生端补充自己的进展证据/);
  assert.match(meetings, /m\.student_id != \?/);
  assert.match(guidance, /不能以导师身份给本人学生档案下达指导/);
  assert.match(ui, /打开本人学生端/);
  assert.match(ui, /返回管理端/);
});
