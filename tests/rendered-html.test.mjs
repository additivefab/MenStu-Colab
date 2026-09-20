import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders a neutral authenticated application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>探研｜科研进展管理系统<\/title>/i);
  assert.match(html, /loading-grid/);
  assert.doesNotMatch(html, /科研进展驾驶舱|学生个人工作台|系统设置/);
});

test("server-renders the standalone student overview route", async () => {
  const response = await render("/students/student-002");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /学生档案/);
  assert.match(html, /正在加载学生档案/);
});

test("keeps the database and Feishu boundaries explicit in source", async () => {
  const [dashboard, styles, studentOverview, database, feishuAuth, browserStart, browserCallback, rosterImport, proposals, proposalMigration, feishuEvents, feishuEventRoute, feishuMessageImport, feishuLongConnection, feishuBridge, meetingImports, feishuMigration, hosting, packageJson] = await Promise.all([
    readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/students/[id]/student-overview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/database.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/feishu-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/feishu/browser/start/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/feishu/browser/callback/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/roster/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/proposals/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_spicy_morlun.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/feishu-events.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feishu/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/feishu-message-import.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feishu/long-connection/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/feishu-long-connection.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feishu/meeting-imports/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_wet_war_machine.sql", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /完整代码由本地 Agent 读取/);
  assert.match(dashboard, /学生端/);
  assert.match(dashboard, /记论文进展/);
  assert.match(dashboard, /记课题进展/);
  assert.match(dashboard, /StudentQuickProgressComposer/);
  assert.match(dashboard, /await onSaved\(\)/);
  assert.doesNotMatch(dashboard, /studentSubmitKind/);
  assert.match(dashboard, /我的进展/);
  assert.match(dashboard, /StudentResearchTracks/);
  assert.match(dashboard, /title="我的研究"/);
  assert.match(dashboard, /type StudentView = "today" \| "research" \| "progress" \| "library" \| "mentor"/);
  assert.match(dashboard, /studentNavigationHref/);
  assert.match(dashboard, /studentNavigationFromLocation/);
  assert.match(dashboard, /window\.addEventListener\("popstate"/);
  assert.match(dashboard, /aria-current=\{view === itemView \? "page" : undefined\}/);
  assert.match(dashboard, /view === "today"/);
  assert.match(dashboard, /today: \{ label: "下一步", icon: "⌂" \}/);
  assert.match(dashboard, /id="student-view-today-title">下一步行动/);
  assert.match(dashboard, /约导师解决阻塞/);
  assert.doesNotMatch(dashboard, /TODAY · 我的科研|今天进展到哪了|今天先做什么/);
  assert.doesNotMatch(dashboard, /<StudentGuidanceInbox compact/);
  assert.match(dashboard, /view === "research"/);
  assert.match(dashboard, /view === "progress"/);
  assert.match(dashboard, /view === "library"/);
  assert.match(dashboard, /view === "mentor"/);
  assert.match(dashboard, /论文研究/);
  assert.match(dashboard, /课题研究/);
  assert.match(dashboard, /title="我的进展"/);
  assert.match(dashboard, /title="导师与组会"/);
  assert.match(dashboard, /if \(intent\.composerKind\) setComposer\(intent\.composerKind\)/);
  assert.match(dashboard, /className="student-persistent-composer" hidden=\{view !== "progress" \|\| !composerVisible\}/);
  assert.match(dashboard, /id="student-meeting-form" tabIndex=\{-1\}/);
  assert.match(styles, /\.student-workbench-shell ~ \.toast/);
  assert.match(styles, /pointer-events: none/);
  assert.match(dashboard, /paperActionCurrent \? "当前安排" : "当前状态"/);
  assert.match(dashboard, /role="progressbar"/);
  assert.match(dashboard, /记录节奏/);
  assert.match(dashboard, /StudentResearchLibrary/);
  assert.match(dashboard, /我的科研资料库/);
  assert.match(dashboard, /attachment\.content_sha256/);
  assert.match(dashboard, /studentEvidenceHref/);
  assert.match(dashboard, /打开来源记录/);
  assert.match(dashboard, /id="student-progress-overview-title"/);
  assert.match(dashboard, /StudentProgressOverview/);
  assert.match(dashboard, /AI 组会/);
  assert.match(dashboard, /entry\.kind === "组会"/);
  assert.match(dashboard, /课题进展/);
  assert.match(dashboard, /最近写了什么、导师怎么回复/);
  assert.match(dashboard, /稿件版本/);
  assert.match(dashboard, /name="nextAction"/);
  assert.match(dashboard, /完整档案 ↗/);
  assert.match(dashboard, /进入学生档案/);
  assert.match(dashboard, /href=\{`\/students\/\$\{encodeURIComponent\(entry\.student_id\)\}#evidence`\}/);
  assert.match(dashboard, /打开 \$\{student\.name\} 的档案与进展/);
  assert.match(dashboard, /查看学生档案/);
  assert.doesNotMatch(dashboard, /import Link from "next\/link"/);
  assert.match(dashboard, /name="attachments" type="file" multiple/);
  assert.match(dashboard, /找导师聊聊/);
  assert.ok(dashboard.indexOf('data?.viewer.role === "student"') < dashboard.indexOf('className="app-shell"'));
  assert.match(dashboard, /不会把 App Secret、飞书访问凭证或完整代码发送给云端 GPT/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS progress_entries/);
  assert.match(feishuAuth, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(feishuAuth, /FEISHU_AUTH_REQUIRED/);
  assert.match(dashboard, /\/api\/auth\/feishu\/browser\/start/);
  assert.match(browserStart, /crypto\.getRandomValues/);
  assert.match(browserStart, /SameSite=Lax/);
  assert.match(browserCallback, /state !== expectedState/);
  assert.match(browserCallback, /createFeishuSession/);
  assert.match(rosterImport, /requireAppUser\(request, \["superadmin"\]\)/);
  assert.match(rosterImport, /assertSameOrigin/);
  assert.doesNotMatch(rosterImport, /displayName\s*!==\s*"佘阳"/);
  assert.doesNotMatch(rosterImport, /SET student_id = 'student-002'/);
  assert.match(rosterImport, /confirmedRoster/);
  assert.match(rosterImport, /counts\?\.total !== 26/);
  assert.match(proposals, /requireAppUser\(request, \["superadmin", "admin"\]\)/);
  assert.doesNotMatch(proposals, /requireAppUser\(request, \["superadmin", "admin", "mentor", "student"\]\)/);
  assert.match(proposals, /assertSameOrigin/);
  assert.match(proposals, /const studentId = cleanText\(body\.studentId, "学生", 80\)/);
  assert.doesNotMatch(proposals, /管理员只能撰写与本人绑定的研究方案/);
  assert.match(proposals, /research_proposal_versions/);
  assert.match(proposals, /proposal_audit_events/);
  assert.match(proposals, /只有授权管理员或超级管理员可以审核研究方案/);
  assert.match(proposalMigration, /CREATE TABLE `research_proposals`/);
  assert.match(proposalMigration, /CREATE UNIQUE INDEX `idx_proposal_versions_proposal_number`/);
  assert.match(dashboard, /飞书 AI 会议总结自动归档/);
  assert.match(dashboard, /\/students\/\$\{encodeURIComponent\(student\.id\)\}/);
  assert.match(dashboard, /className="mentor-inbox-summary"/);
  assert.match(dashboard, /if \(pending\) return/);
  assert.match(dashboard, /无需反复点击飞书授权/);
  assert.match(dashboard, /重新检查权限/);
  assert.match(dashboard, /切换飞书账号/);
  assert.match(dashboard, /key=\{authGate\.kind\}/);
  assert.doesNotMatch(dashboard, /value="mentor"/);
  assert.match(dashboard, /onReview=\{review\}/);
  assert.match(studentOverview, /进展与审核/);
  assert.match(studentOverview, /研究资料/);
  assert.match(studentOverview, /指导记录/);
  assert.match(studentOverview, /project: \{/);
  assert.match(studentOverview, /mentorView=research&researchTab=proposals&proposal=\$\{proposal\.id\}/);
  assert.match(studentOverview, /paper\.status === "active"\s*\? paperDeadlineState/);
  assert.match(studentOverview, /hidden=\{tab !== "guidance"\}/);
  assert.match(studentOverview, /hidden=\{tab !== "research"\}/);
  assert.match(studentOverview, /hidden=\{!composeOpen\}/);
  assert.doesNotMatch(studentOverview, /<select name="guidanceType"/);
  assert.match(studentOverview, /退回并发送指导/);
  assert.match(studentOverview, /\/api\/reviews/);
  assert.match(studentOverview, /entry\.can_finalize/);
  assert.match(studentOverview, /window\.location\.replace\("\/"\)/);
  assert.match(studentOverview, /window\.addEventListener\("hashchange"/);
  assert.match(studentOverview, /if \(loading && !student\)/);
  assert.match(studentOverview, /\/api\/student-guidance/);
  assert.match(studentOverview, /\/api\/dashboard/);
  assert.match(studentOverview, /\/api\/proposals/);
  assert.doesNotMatch(studentOverview, /student-context-dock|student-hero-evidence|student-flow-card|student-ai-summary-archive/);
  assert.match(feishuEvents, /x-lark-signature/);
  assert.match(feishuEvents, /iv: encrypted\.slice\(0, 16\)/);
  assert.match(feishuEvents, /encrypted\.slice\(16\)/);
  assert.match(feishuEvents, /会议总结/);
  assert.match(feishuEvents, /normalized\.length >= 120 && matches\.length >= 2/);
  assert.match(feishuEventRoute, /header\.event_type !== "im\.message\.receive_v1"/);
  assert.match(feishuMessageImport, /message\.chat_type !== "group"/);
  assert.ok(feishuMessageImport.indexOf("if (!detectedReason)") < feishuMessageImport.indexOf("await ensureDatabase()"));
  assert.match(feishuMessageImport, /INSERT OR IGNORE INTO feishu_meeting_summary_imports/);
  assert.match(feishuMessageImport, /source:\$\{await sha256Text\(sourceFingerprint\)\}/);
  assert.match(feishuMessageImport, /splitMeetingProgressByStudent/);
  assert.match(feishuMessageImport, /飞书智能纪要自动拆分/);
  assert.match(feishuLongConnection, /verifyLongConnectionRelay/);
  assert.doesNotMatch(feishuLongConnection, /event\.token/);
  assert.doesNotMatch(feishuBridge, /!chatId \|\| !commandEvent\.token/);
  assert.match(feishuBridge, /document\.rawContent/);
  assert.match(feishuBridge, /im\.v1\.message\.get/);
  assert.match(feishuBridge, /im\.v1\.message\.reply/);
  assert.match(feishuBridge, /uuid: createHmac/);
  assert.match(feishuBridge, /message\.parent_id \|\| message\.root_id/);
  assert.match(feishuBridge, /extractFeishuDocxDocumentIds\(text\)\.length > 0/);
  assert.match(feishuBridge, /allowBareDocx: false/);
  assert.match(feishuBridge, /outcome: "source_unreadable"/);
  assert.match(feishuBridge, /\.slice\(0, 60_000\)/);
  assert.match(feishuBridge, /detectMeetingSummary\(content\)/);
  assert.match(feishuBridge, /spawn\(curlBin/);
  assert.match(feishuBridge, /--http1\.1/);
  assert.match(feishuBridge, /--proto/);
  assert.match(feishuBridge, /=https/);
  assert.doesNotMatch(feishuBridge, /fetch\(relayUrl/);
  assert.match(meetingImports, /requireAppUser\(request, \["superadmin"\]\)/);
  assert.match(meetingImports, /assertSameOrigin/);
  assert.match(meetingImports, /review_status, submitted_by_user_id, updated_at/);
  assert.match(meetingImports, /VALUES \(\?, '组会'/);
  assert.match(meetingImports, /raw_content = '', extracted_text = ''/);
  assert.match(meetingImports, /chat_id = '', sender_id = '', sender_type = '', raw_content = ''/);
  assert.match(feishuMigration, /CREATE UNIQUE INDEX `idx_feishu_summary_event_unique`/);
  assert.match(feishuMigration, /CREATE UNIQUE INDEX `idx_feishu_summary_message_unique`/);
  assert.match(hosting, /"d1": "DB"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
