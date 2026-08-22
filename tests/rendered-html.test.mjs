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

test("server-renders the research progress application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>探研｜科研进展管理系统<\/title>/i);
  assert.match(html, /科研进展驾驶舱/);
  assert.match(html, /飞书已登录/);
  assert.match(html, /AI 数据边界已启用/);
});

test("keeps the database and Feishu boundaries explicit in source", async () => {
  const [dashboard, database, feishuAuth, browserStart, browserCallback, rosterImport, proposals, proposalMigration, feishuEvents, feishuEventRoute, feishuMessageImport, feishuLongConnection, feishuBridge, meetingImports, feishuMigration, hosting, packageJson] = await Promise.all([
    readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"),
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
  assert.match(dashboard, /不会把 App Secret、飞书访问凭证或完整代码发送给云端 GPT/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS progress_entries/);
  assert.match(feishuAuth, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(feishuAuth, /FEISHU_AUTH_REQUIRED/);
  assert.match(dashboard, /\/api\/auth\/feishu\/browser\/start/);
  assert.match(browserStart, /crypto\.getRandomValues/);
  assert.match(browserStart, /SameSite=Lax/);
  assert.match(browserCallback, /state !== expectedState/);
  assert.match(browserCallback, /createFeishuSession/);
  assert.match(rosterImport, /requireAppUser\(request, \["admin"\]\)/);
  assert.match(rosterImport, /assertSameOrigin/);
  assert.match(rosterImport, /confirmedRoster/);
  assert.match(rosterImport, /counts\?\.total !== 26/);
  assert.match(proposals, /requireAppUser\(request, \["admin", "student"\]\)/);
  assert.match(proposals, /assertSameOrigin/);
  assert.match(proposals, /管理员只能撰写与本人绑定的研究方案/);
  assert.match(proposals, /research_proposal_versions/);
  assert.match(proposals, /proposal_audit_events/);
  assert.match(proposals, /只有管理员可以审核研究方案/);
  assert.match(proposalMigration, /CREATE TABLE `research_proposals`/);
  assert.match(proposalMigration, /CREATE UNIQUE INDEX `idx_proposal_versions_proposal_number`/);
  assert.match(dashboard, /飞书 AI 会议总结待确认区/);
  assert.match(feishuEvents, /x-lark-signature/);
  assert.match(feishuEvents, /iv: encrypted\.slice\(0, 16\)/);
  assert.match(feishuEvents, /encrypted\.slice\(16\)/);
  assert.match(feishuEvents, /会议总结/);
  assert.match(feishuEvents, /normalized\.length >= 120 && matches\.length >= 2/);
  assert.match(feishuEventRoute, /header\.event_type !== "im\.message\.receive_v1"/);
  assert.match(feishuMessageImport, /message\.chat_type !== "group"/);
  assert.ok(feishuMessageImport.indexOf("if (!detectedReason)") < feishuMessageImport.indexOf("await ensureDatabase()"));
  assert.match(feishuMessageImport, /INSERT OR IGNORE INTO feishu_meeting_summary_imports/);
  assert.match(feishuLongConnection, /verifyLongConnectionRelay/);
  assert.doesNotMatch(feishuLongConnection, /event\.token/);
  assert.doesNotMatch(feishuBridge, /!chatId \|\| !commandEvent\.token/);
  assert.match(feishuBridge, /document\.rawContent/);
  assert.match(feishuBridge, /\.slice\(0, 60_000\)/);
  assert.match(feishuBridge, /detectMeetingSummary\(content\)/);
  assert.match(feishuBridge, /spawn\(curlBin/);
  assert.match(feishuBridge, /--proto/);
  assert.match(feishuBridge, /=https/);
  assert.doesNotMatch(feishuBridge, /fetch\(relayUrl/);
  assert.match(meetingImports, /requireAppUser\(request, \["admin"\]\)/);
  assert.match(meetingImports, /assertSameOrigin/);
  assert.match(meetingImports, /VALUES \(\?, '组会'/);
  assert.match(meetingImports, /raw_content = '', extracted_text = ''/);
  assert.match(meetingImports, /chat_id = '', sender_id = '', sender_type = '', raw_content = ''/);
  assert.match(feishuMigration, /CREATE UNIQUE INDEX `idx_feishu_summary_event_unique`/);
  assert.match(feishuMigration, /CREATE UNIQUE INDEX `idx_feishu_summary_message_unique`/);
  assert.match(hosting, /"d1": "DB"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
