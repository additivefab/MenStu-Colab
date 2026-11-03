import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [panel, taskCard, runCard, runForm, changeCard, attemptCard, adminPanel, labels, api, overview, dashboard, seed] = await Promise.all([
  read("components/research-loop/research-loop-panel.tsx"),
  read("components/research-loop/task-card.tsx"),
  read("components/research-loop/run-card.tsx"),
  read("components/research-loop/run-form.tsx"),
  read("components/research-loop/change-request-card.tsx"),
  read("components/research-loop/attempt-card.tsx"),
  read("components/research-loop/admin-panel.tsx"),
  read("components/research-loop/labels.ts"),
  read("components/research-loop/api.ts"),
  read("app/students/[id]/student-overview.tsx"),
  read("app/dashboard.tsx"),
  read("scripts/local-dev/seed-research-loop.mjs"),
]);

test("research-loop UI never re-derives authorization from the viewer role", () => {
  for (const [name, source] of Object.entries({ panel, taskCard, runCard, runForm, changeCard, attemptCard })) {
    assert.doesNotMatch(source, /\.role\b|superadmin|canReviewStudent|canViewStudent/u, `${name} must rely on server permissions`);
  }
  assert.match(taskCard, /permissions\?\.canConfirm/u);
  assert.match(taskCard, /permissions\.canStartAttempt/u);
  assert.match(changeCard, /permissions\.canPublish/u);
  assert.match(changeCard, /permissions\.canApproveExtraReview/u);
  assert.match(runCard, /permissions\?\.canApprove/u);
  assert.match(runCard, /permissions\.canReview/u);
});

test("approval echoes the exact spec hash shown to the reviewer", () => {
  assert.match(runCard, /action: "approve", runSpecSha256: current\.runSpecSha256/u);
  assert.match(runCard, /<code className=\{styles\.hash\}>\{current\.runSpecSha256\}<\/code>/u);
  for (const field of ["运行 ID", "执行提交", "数据集版本", "入口", "资源", "网络与外发", "评价协议", "基线"]) {
    assert.match(runCard, new RegExp(`label="${field}"`, "u"), `run card pins ${field}`);
  }
});

test("technical validity, hypothesis outcome and human acceptance stay separate", () => {
  assert.match(runCard, /技术有效性/u);
  assert.match(runCard, /假设结论/u);
  assert.match(runCard, /导师评审/u);
  assert.match(runCard, /value="accepted" disabled=\{!valid\}/u);
  assert.match(labels, /completed: \["执行结束", "neutral"\]/u);
  assert.doesNotMatch(labels, /completed: \["[^"]*验收/u);
  assert.match(labels, /held: \["保留在实验室"/u);
  assert.match(runCard, /\/api\/run-artifacts\?artifactId=/u);
  assert.match(runCard, /action: "followup", runId: detail\.run\.id, mutationId: followupKey/u);
});

test("failed attempts and runs stay visible with their reason", () => {
  assert.match(attemptCard, /status === "failed" \|\| status === "canceled"/u);
  assert.match(attemptCard, /errorMessage \|\| "未提供原因"/u);
  assert.match(runCard, /current\.failureReason \|\| "运行失败，未提供原因"/u);
  assert.match(panel, /失败和取消的运行也会保留在这里|filter === "open"/u);
});

test("agent events are polled incrementally with afterSequence", () => {
  assert.match(attemptCard, /afterSequence=\$\{after\.current\}/u);
  assert.match(attemptCard, /after\.current = payload\.nextAfterSequence/u);
  assert.match(attemptCard, /window\.setInterval/u);
});

test("profile, student portal and settings render the research loop", () => {
  assert.match(overview, /switchTab\("loop"\)\}>科研闭环<\/button>/u);
  assert.match(overview, /sourceGuidanceNoteId: note\.id/u);
  assert.match(overview, />转为研究任务<\/button>/u);
  assert.match(panel, /sourceGuidanceNoteId: creating\.sourceGuidanceNoteId/u);
  assert.match(dashboard, /<ResearchLoopPanel studentId=\{student\.id\} mode="student" \/>/u);
  assert.match(dashboard, /viewer\.role === "superadmin" \? <ResearchLoopAdmin/u);
});

test("admin UI never sends credentials and shows the runner token only once", () => {
  assert.match(adminPanel, /action: "create", userId: Number\(values\.get\("userId"\)\), provider: values\.get\("provider"\), workerId: values\.get\("workerId"\)/u);
  assert.doesNotMatch(adminPanel, /oauth_token|apiKey|CODEX_HOME/iu);
  assert.match(adminPanel, /凭据只显示这一次/u);
  assert.match(adminPanel, /setIssued\(null\)/u);
  assert.match(api, /credentials: "same-origin"/u);
});

test("local seed script stays local and never prints the generated password", () => {
  assert.match(seed, /\.wrangler\/state\/v3\/d1/u);
  assert.doesNotMatch(seed, /console\.(?:log|info|error)\((?:password|[^)]*\$\{password\})/u);
  assert.match(seed, /合成/u);
});
