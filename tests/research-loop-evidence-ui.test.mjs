import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EVIDENCE_MAX_DAYS, draftNoticeText, draftRunNumber, draftRunParam, evidenceReportText, evidenceUrl, loopCardHref, metricsSummary,
  needsInterpretation, parseProgressDraft, presetPeriod, progressDraftPrefill, validatePeriod,
} from "../components/research-loop/evidence-model.ts";

// Synthetic fixtures typed after lib/research-loop/results-contract.ts.
const draft = {
  kind: "项目",
  title: "运行 #3：注意力模块消融",
  summary: "注意力模块让 mIoU 提升约 1.8 个点",
  evidence: "运行 #3 · 执行提交 e4a0801 · metrics.json sha256 abcd",
  evidenceSources: [
    { sourceType: "url", label: "PR #12", ref: "https://github.com/lab/proj/pull/12" },
    { sourceType: "git", label: "执行提交", ref: "e4a0801" },
    { sourceType: "git", label: "代码仓库", ref: "https://github.com/lab/proj/tree/e4a0801" },
  ],
  from: { taskId: "task_1", runId: "run_3", changeRequestId: "cr_1", interpretationVersion: 2 },
};

const run = (over = {}) => ({
  runId: "run_3", taskId: "task_1", number: 3, status: "completed", technicalValidity: "valid", reviewState: "pending",
  endedAt: "2026-11-02T10:00:00.000Z", metrics: { mIoU: 0.71, loss: 0.3 }, failureReason: "", interpreted: false, ...over,
});

const report = {
  studentId: "stu_1",
  period: { from: "2026-10-28", to: "2026-11-03" },
  tasks: [{ taskId: "task_1", title: "注意力模块消融", status: "confirmed", versionsConfirmed: 1, created: true }],
  changeRequests: [{ id: "cr_1", taskId: "task_1", prNumber: 12, prUrl: "https://github.com/lab/proj/pull/12", status: "open", createdAt: "2026-10-30T00:00:00Z" }],
  runs: [run(), run({ runId: "run_4", number: 4, status: "failed", interpreted: true, metrics: null, failureReason: "OOM" })],
  blockers: [{ kind: "run_failed", text: "运行 #4 失败：OOM", taskId: "task_1", runId: "run_4" }],
};

test("evidence periods: presets, custom validation and the 62-day limit", () => {
  assert.deepEqual(presetPeriod("week", "2026-11-03"), { from: "2026-10-28", to: "2026-11-03" });
  assert.deepEqual(presetPeriod("week", "2026-03-02"), { from: "2026-02-24", to: "2026-03-02" });
  assert.deepEqual(presetPeriod("month", "2026-11-03"), { from: "2026-11-01", to: "2026-11-03" });
  assert.equal(EVIDENCE_MAX_DAYS, 62);
  assert.deepEqual(validatePeriod("2026-09-03", "2026-11-03"), { period: { from: "2026-09-03", to: "2026-11-03" } }); // 62 days inclusive
  assert.match(validatePeriod("2026-09-02", "2026-11-03").error, /62/u);
  assert.match(validatePeriod("2026-11-04", "2026-11-03").error, /晚于/u);
  assert.ok("error" in validatePeriod("", "2026-11-03"));
  assert.ok("error" in validatePeriod("2026-02-30", "2026-03-03"));
  assert.equal(evidenceUrl("stu 1", { from: "2026-11-01", to: "2026-11-03" }), "/api/research-loop/evidence?studentId=stu+1&from=2026-11-01&to=2026-11-03");
});

test("loop card links: profile URL from the dashboard, in-page hash on the profile", () => {
  assert.equal(loopCardHref("stu_1", { kind: "task", id: "task_1" }, false), "/students/stu_1#research-task-task_1");
  assert.equal(loopCardHref("stu_1", { kind: "run", id: "run_3" }, true), "#research-run-run_3");
  // Students cannot open /students/<id> (redirect drops the hash): use their research view.
  assert.equal(loopCardHref("stu_1", { kind: "run", id: "run_3" }, false, true), "/?studentView=research#research-run-run_3");
});

test("runs: interpretation prompt only for terminal, uninterpreted runs; neutral metrics text", () => {
  assert.equal(needsInterpretation(run()), true);
  assert.equal(needsInterpretation(run({ status: "failed" })), true);
  assert.equal(needsInterpretation(run({ status: "running" })), false);
  assert.equal(needsInterpretation(run({ interpreted: true })), false);
  assert.equal(metricsSummary({ a: 1, b: 2 }), "a=1 · b=2");
  assert.equal(metricsSummary({ a: 1, b: 2, c: 3 }, 2), "a=1 · b=2 · …");
  assert.equal(metricsSummary(null), "");
});

test("evidence text lists the evidence and leaves the three questions for the student, without scores", () => {
  const text = evidenceReportText(report);
  assert.match(text, /2026-10-28 至 2026-11-03/u);
  assert.match(text, /注意力模块消融（本周期新建）/u);
  assert.match(text, /PR #12 · 注意力模块消融 · https:\/\/github.com\/lab\/proj\/pull\/12/u);
  assert.match(text, /运行 #3 · 注意力模块消融 · mIoU=0.71 · loss=0.3（尚未解读）/u);
  assert.match(text, /运行 #4 失败：OOM/u);
  for (const prompt of ["为什么这样做：", "意味着什么：", "下一步如何判断："]) assert.ok(text.includes(prompt));
  assert.doesNotMatch(text, /得分|排名|活跃度|次数/u);
  const empty = evidenceReportText({ ...report, tasks: [], changeRequests: [], runs: [], blockers: [] });
  assert.equal(empty.match(/- 无/gu).length, 4);
});

test("draft hand-off: run param, parsing, notice and composer prefill", () => {
  assert.equal(draftRunParam("run_3"), "run_3");
  assert.equal(draftRunParam("../x"), null);
  assert.equal(draftRunParam(null), null);

  assert.equal(parseProgressDraft(null), null);
  assert.equal(parseProgressDraft("{not json"), null);
  assert.equal(parseProgressDraft(JSON.stringify({ title: 1 })), null);
  const parsed = parseProgressDraft(JSON.stringify({ ...draft, evidenceSources: [...draft.evidenceSources, { sourceType: "ftp", label: "x", ref: "y" }] }));
  assert.equal(parsed.evidenceSources.length, 3);
  assert.equal(parsed.from.runId, "run_3");

  assert.equal(draftRunNumber(draft), 3);
  assert.equal(draftNoticeText(draft), "已根据运行 #3 生成草稿，请补充你的判断后提交；提交后仍由导师审核");
  assert.match(draftNoticeText({ ...draft, title: "消融", evidence: "", summary: "x" }), /所选运行/u);
  assert.match(draftNoticeText(null), /没有找到/u);

  const prefill = progressDraftPrefill(draft);
  assert.equal(prefill.summary.split("\n")[0], draft.title); // the composer derives the title from line 1
  assert.ok(prefill.summary.includes(draft.summary));
  assert.equal(prefill.gitUrl, "https://github.com/lab/proj/tree/e4a0801");
  assert.ok(prefill.evidence.startsWith(draft.evidence));
  assert.match(prefill.evidence, /PR #12（链接）：https:\/\/github.com\/lab\/proj\/pull\/12/u);
  assert.match(prefill.evidence, /执行提交（代码）：e4a0801/u);
  assert.doesNotMatch(prefill.evidence, /tree\/e4a0801/u);
  assert.equal(progressDraftPrefill({ ...draft, evidenceSources: [], evidence: "x".repeat(5000) }).evidence.length, 4000);
  assert.equal(progressDraftPrefill({ ...draft, summary: "运行 #3：注意力模块消融。提升明显" }).summary, "运行 #3：注意力模块消融。提升明显");
});

test("UI wiring: composer reads the draft, never auto-submits, clears it; list placed in both views", async () => {
  const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /params\.get\("studentView"\) \?\? params\.get\("view"\)/u);
  assert.match(dashboard, /draftRunParam\(params\.get\("draftRun"\)\)/u);
  assert.match(dashboard, /sessionStorage\.getItem\(progressDraftStorageKey/u);
  assert.match(dashboard, /sessionStorage\.removeItem\(progressDraftStorageKey/u);
  assert.match(dashboard, /<EvidenceList studentId=\{student\.id\} mode="student" \/>/u);
  assert.doesNotMatch(dashboard, /requestSubmit\(/u);
  const profile = await readFile(new URL("../app/students/[id]/student-overview.tsx", import.meta.url), "utf8");
  assert.match(profile, /<EvidenceList studentId=\{studentId\} mode=\{viewerRole === "student" \? "student" : "staff"\} inPage \/>/u);
  const list = await readFile(new URL("../components/research-loop/evidence-list.tsx", import.meta.url), "utf8");
  assert.match(list, /周会证据清单/u);
  assert.match(list, /useState\(!staff\)/u); // staff: collapsed by default
});
