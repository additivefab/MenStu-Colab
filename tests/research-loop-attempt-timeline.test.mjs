import assert from "node:assert/strict";
import test from "node:test";
import { buildTimeline, capEvents, mergeEvents } from "../components/research-loop/attempt-timeline.ts";

let seq = 0;
const ev = (kind, payload, createdAt = "2026-11-03T08:00:00Z") => ({ sequence: ++seq, kind, payload, createdAt });

test("worker event stream becomes Chinese milestones with folded details", () => {
  seq = 0;
  const events = [
    ev("status", { phase: "claimed", provider: "codex", modelId: "gpt-5-codex", baseCommitSha: "a".repeat(40), workerId: null }),
    ev("status", { phase: "adapter", capabilities: {} }),
    ev("status", { phase: "workspace_ready", head: "abcdef0123456789" }),
    ev("status", { phase: "agent_started", maxAgentMinutes: 30, maxTurns: 40 }),
    ev("status", { phase: "thread_started", threadId: "t1" }),
    ev("message", { role: "assistant", text: "先读代码" }),
    ev("tool_call", { tool: "shell", itemId: "i1", command: "bash -lc 'pytest -q'" }),
    ev("tool_result", { tool: "shell", itemId: "i1", command: "bash -lc 'pytest -q'", status: "completed", exitCode: 1, output: "1 failed" }),
    ev("test", { command: "bash -lc 'pytest -q'", exitCode: 1, summary: "....\n1 failed, 3 passed" }),
    ev("file_change", { status: "completed", changes: [{ path: "src/train.py", kind: "update" }] }),
    ev("test", { command: "pytest -q", exitCode: 0, summary: "4 passed" }),
    ev("usage", { inputTokens: 10, outputTokens: 5 }),
    ev("message", { role: "assistant", text: "  修复了随机种子。\n测试全部通过。  " }),
    ev("status", { phase: "changes_collected", files: [{ path: "src/train.py", action: "modify" }], outsideAllowed: [], protectedTouched: [] }),
    ev("status", { phase: "result", outcome: "change_ready", errorCode: null, tests: 2 }),
  ];
  const timeline = buildTimeline(events);
  assert.deepEqual(timeline.milestones.map((item) => item.label), ["领取任务", "工作区就绪", "代理开始", "测试", "测试", "产出修改", "结束"]);
  const [claimed, workspace, started, failedTest, passedTest, produced, end] = timeline.milestones;
  assert.match(claimed.detail, /gpt-5-codex/u);
  assert.equal(workspace.detail, "基于 abcdef0123");
  assert.equal(started.detail, "预算 30 分钟");
  assert.equal(failedTest.detail, "bash -lc 'pytest -q' · 退出码 1 · 1 failed, 3 passed");
  assert.equal(failedTest.tone, "bad");
  assert.equal(passedTest.tone, "good");
  assert.equal(produced.detail, "1 个文件");
  assert.equal(end.detail, "已产出修改");
  assert.equal(end.tone, "good");
  assert.equal(end.createdAt, "2026-11-03T08:00:00Z");
  // adapter + thread_started + message×2 + tool_call + tool_result + file_change + usage
  assert.equal(timeline.detailCount, 8);
  assert.equal(timeline.agentSummary, "修复了随机种子。 测试全部通过。");
});

test("failure end shows the error code; error events stay visible", () => {
  seq = 0;
  const timeline = buildTimeline([
    ev("status", { phase: "agent_started", maxAgentMinutes: 5 }),
    ev("error", { code: "BUDGET_EXCEEDED", maxAgentMinutes: 5 }),
    ev("status", { phase: "result", outcome: "failed", errorCode: "BUDGET_EXCEEDED", tests: 0 }),
  ]);
  assert.deepEqual(timeline.milestones.map((item) => [item.label, item.detail, item.tone]), [
    ["代理开始", "预算 5 分钟", "info"],
    ["错误", "BUDGET_EXCEEDED", "bad"],
    ["结束", "失败 · BUDGET_EXCEEDED", "bad"],
  ]);
  assert.equal(timeline.agentSummary, null);
  assert.equal(timeline.detailCount, 0);
});

test("policy violation and protected paths are reflected in the produced-change milestone", () => {
  seq = 0;
  const timeline = buildTimeline([
    ev("status", { phase: "changes_collected", files: [{ path: "a" }, { path: "b" }], outsideAllowed: ["b"], protectedTouched: [] }),
    ev("status", { phase: "protected_paths_touched", paths: ["eval_protocol/x.py"] }),
  ]);
  assert.deepEqual(timeline.milestones.map((item) => [item.label, item.detail, item.tone]), [
    ["产出修改", "2 个文件 · 1 个超出允许范围", "bad"],
    ["产出修改", "涉及受保护路径 1 个，需额外审查", "warn"],
  ]);
});

test("legacy seed shapes and missing fields are tolerated", () => {
  seq = 0;
  const timeline = buildTimeline([
    ev("status", { status: "started" }),
    ev("file_change", { path: "data/splits/val.txt" }),
    ev("error", { message: "修改了任务范围之外的文件" }),
    ev("test", { command: "pytest -q tests/test_seed.py", summary: "3 passed" }),
    ev("status", { status: "change_ready" }),
  ]);
  assert.deepEqual(timeline.milestones.map((item) => [item.label, item.detail]), [
    ["代理开始", null],
    ["错误", "修改了任务范围之外的文件"],
    ["测试", "pytest -q tests/test_seed.py · 退出码未上报 · 3 passed"],
    ["结束", "已产出修改"],
  ]);
  assert.equal(timeline.milestones[2].tone, "neutral");
  assert.equal(timeline.detailCount, 1);
});

test("unknown kinds, odd payloads and empty input never throw", () => {
  seq = 0;
  assert.deepEqual(buildTimeline(undefined), { milestones: [], detailCount: 0, agentSummary: null });
  assert.deepEqual(buildTimeline([]), { milestones: [], detailCount: 0, agentSummary: null });
  const timeline = buildTimeline([
    ev("telemetry", { anything: 1 }),
    ev("status", null),
    ev("status", ["not", "an", "object"]),
    ev("status", { phase: 42 }),
    ev("test", { command: 7, exitCode: "0" }),
    ev("error", {}),
    ev("message", { text: 123 }),
    ev("message", { text: "   " }),
    ev("status", { phase: "result" }),
    { sequence: 99, kind: "message" },
  ]);
  assert.deepEqual(timeline.milestones.map((item) => [item.label, item.detail]), [
    ["测试", "命令未上报 · 退出码未上报"],
    ["错误", null],
    ["结束", "结果未上报"],
  ]);
  assert.equal(timeline.detailCount, 7);
  assert.equal(timeline.agentSummary, null);
});

test("agent summary uses the last message and is capped near 300 chars; long commands are clipped", () => {
  seq = 0;
  const long = "很长的说明".repeat(100);
  const timeline = buildTimeline([
    ev("message", { text: "最终之前" }),
    ev("message", { role: "final", text: long }),
    ev("test", { command: `pytest ${"x".repeat(500)}`, exitCode: 0 }),
  ]);
  assert.equal(timeline.agentSummary.length, 301);
  assert.ok(timeline.agentSummary.endsWith("…"));
  assert.ok(timeline.milestones[0].detail.length < 200);
});

test("capEvents drops the oldest detail events first and keeps milestones", () => {
  seq = 0;
  const events = [
    ev("status", { phase: "claimed" }),
    ...Array.from({ length: 10 }, (_, index) => ev("message", { text: `m${index}` })),
    ev("test", { command: "pytest", exitCode: 0 }),
    ev("message", { text: "last" }),
  ];
  const capped = capEvents(events, 5);
  assert.equal(capped.length, 5);
  assert.deepEqual(capped.map((item) => item.sequence), [1, 10, 11, 12, 13]);
  assert.equal(capEvents(events, 100).length, events.length);
  const onlyMilestones = Array.from({ length: 6 }, () => ev("status", { phase: "claimed" }));
  assert.equal(capEvents(onlyMilestones, 4).length, 4);
});

test("mergeEvents ignores overlapping pages and keeps the same array when nothing is new", () => {
  seq = 0;
  const first = [ev("status", { phase: "claimed" }), ev("message", { text: "a" })];
  const second = [first[1], ev("message", { text: "b" })];
  const merged = mergeEvents(first, second, 400);
  assert.deepEqual(merged.map((item) => item.sequence), [1, 2, 3]);
  assert.equal(mergeEvents(merged, second, 400), merged);
});
