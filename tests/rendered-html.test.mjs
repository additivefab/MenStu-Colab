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
  const [dashboard, database, feishuAuth, browserStart, browserCallback, rosterImport, hosting, packageJson] = await Promise.all([
    readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/database.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/feishu-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/feishu/browser/start/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/feishu/browser/callback/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/roster/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /完整代码由本地 Agent 读取/);
  assert.match(dashboard, /App Secret 只保存在加密环境变量中/);
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
  assert.match(hosting, /"d1": "DB"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
