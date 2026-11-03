import assert from "node:assert/strict";
import test from "node:test";
import { computeTaskStages, STAGE_LABELS } from "../components/research-loop/stage-model.ts";

// Synthetic fixtures. Timestamps are fixed strings so the model never depends on the clock.
const T = (minute) => `2026-11-03T08:${String(minute).padStart(2, "0")}:00.000Z`;

const task = (over = {}) => ({
  id: "task_1", studentId: "s1", title: "对比学习率", status: "confirmed", currentVersion: 2, confirmedVersion: 2,
  sourceGuidanceNoteId: null, sourceRunId: null, parentTaskId: null, createdByUserId: 1,
  createdAt: T(0), updatedAt: T(0), ...over,
});

const attempt = (id, minute, status, over = {}) => ({
  id, taskVersion: 2, provider: "codex", modelId: "m", status, baseCommitSha: "a".repeat(40),
  errorCode: "", errorMessage: "", requestedByUserId: 1,
  createdAt: T(minute), startedAt: null, endedAt: null, updatedAt: T(minute + 1), ...over,
});

const cr = (id, attemptId, status, over = {}) => ({
  id, attemptId, status, requiresExtraReview: false, extraReviewApprovedAt: null, prNumber: null, ...over,
});

const run = (id, minute, status, over = {}) => ({
  id, attempt: 1, status, taskId: "task_1", studentId: "s1", runSpecSha256: "b".repeat(64), approvalId: null,
  submitTag: `tanyan-${id}`, runnerId: null, exitCode: null, failureReason: "", cancelRequestedAt: null,
  createdByUserId: 1, createdAt: T(minute), queuedAt: null, startedAt: null, endedAt: null,
  executedCommitSha: "c".repeat(40), entrypointId: "ep", datasetVersionId: "ds", changeRequestId: null,
  technicalValidity: null, reviewState: null, ...over,
});

const input = (over = {}) => ({ task: task(), attempts: [], changeRequests: [], runs: [], ...over });

/** Compact view of a result: "state/owner" per stage. */
const shape = (result) => Object.fromEntries(result.stages.map((stage) => [stage.key, `${stage.state}/${stage.owner ?? "-"}`]));
const stage = (result, key) => result.stages.find((item) => item.key === key);

// Each case: input, expected stage shape subset, summaries (substring match), next {text, owner, target}, current.
const cases = [
  {
    name: "draft never confirmed → student (or mentor) confirms",
    input: input({ task: task({ status: "draft", currentVersion: 1, confirmedVersion: null }) }),
    shape: { task: "active/student", code: "idle/-", run: "idle/-", result: "idle/-", next: "idle/-" },
    summary: { task: "第 1 版待确认" },
    next: { text: "学生需确认第 1 版任务（导师也可确认）", owner: "student", target: { kind: "task", taskId: "task_1" } },
    current: "task",
  },
  {
    name: "draft after revision → re-confirm the current version",
    input: input({ task: task({ status: "draft", currentVersion: 3, confirmedVersion: 2 }) }),
    shape: { task: "active/student", code: "idle/-" },
    summary: { task: "第 3 版待重新确认" },
    next: { text: "学生需重新确认第 3 版任务（导师也可确认）", owner: "student", target: { kind: "task", taskId: "task_1" } },
    current: "task",
  },
  {
    name: "revised draft with earlier runs: re-confirmation comes first, history kept",
    input: input({
      task: task({ status: "draft", currentVersion: 3, confirmedVersion: 2 }),
      runs: [run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "accepted" })],
    }),
    shape: { task: "active/student", code: "skipped/-", run: "done/-", result: "done/-", next: "active/student" },
    nextText: "学生需重新确认第 3 版任务（导师也可确认）",
    current: "task",
  },
  {
    name: "confirmed, nothing yet → hand to agent or register a run",
    input: input(),
    shape: { task: "done/-", code: "active/student", run: "idle/-", result: "idle/-", next: "idle/-" },
    summary: { task: "第 2 版已确认", code: "可以交给代理修改代码，或直接登记运行" },
    next: { text: "学生可以交给代理修改代码，或直接登记运行", owner: "student", target: { kind: "task", taskId: "task_1" } },
    current: "code",
  },
  {
    name: "queued attempt → agent working",
    input: input({ attempts: [attempt("a1", 1, "queued")] }),
    shape: { code: "working/agent", run: "idle/-" },
    summary: { code: "代理 #1 排队中" },
    next: { text: "等待代理 #1 开始修改代码", owner: "agent", target: { kind: "attempt", taskId: "task_1", attemptId: "a1" } },
    current: "code",
  },
  {
    name: "running attempt (second one) → agent working, numbered #2",
    input: input({ attempts: [attempt("a2", 5, "running"), attempt("a1", 1, "failed", { errorMessage: "超时" })] }),
    shape: { code: "working/agent" },
    summary: { code: "代理 #2 正在修改代码" },
    next: { text: "等待代理 #2 完成代码修改", owner: "agent", target: { kind: "attempt", taskId: "task_1", attemptId: "a2" } },
  },
  {
    name: "waiting_approval attempt counts as agent busy",
    input: input({ attempts: [attempt("a1", 1, "waiting_approval")] }),
    shape: { code: "working/agent" },
  },
  {
    name: "cancel_requested attempt → working",
    input: input({ attempts: [attempt("a1", 1, "cancel_requested")] }),
    shape: { code: "working/agent" },
    summary: { code: "代理 #1 正在取消" },
    nextText: "等待代理 #1 取消",
  },
  {
    name: "latest attempt failed without change request → student handles failure",
    input: input({ attempts: [attempt("a1", 1, "failed", { errorCode: "AGENT_TIMEOUT", errorMessage: "代理在 30 分钟内没有完成" })] }),
    shape: { code: "failed/student", run: "idle/-" },
    summary: { code: "代理 #1 失败：代理在 30 分钟内没有完成" },
    next: { text: "学生需处理代理 #1 的失败：代理在 30 分钟内没有完成", owner: "student", target: { kind: "attempt", taskId: "task_1", attemptId: "a1" } },
    current: "code",
  },
  {
    name: "failed attempt without message falls back to error code; long messages are shortened",
    input: input({ attempts: [attempt("a1", 1, "failed", { errorCode: "POLICY_VIOLATION" })] }),
    summary: { code: "代理 #1 失败：POLICY_VIOLATION" },
  },
  {
    name: "pending review with protected paths → mentor extra review",
    input: input({
      attempts: [attempt("a1", 1, "change_ready")],
      changeRequests: [cr("cr1", "a1", "pending_review", { requiresExtraReview: true })],
    }),
    shape: { code: "active/mentor", run: "idle/-" },
    summary: { code: "变更触及受保护路径，待导师额外审查" },
    next: { text: "等待导师额外审查代理 #1 的变更（触及受保护路径）", owner: "mentor", target: { kind: "changeRequest", taskId: "task_1", changeRequestId: "cr1" } },
    current: "code",
  },
  {
    name: "pending review, extra review already approved → student publishes",
    input: input({
      attempts: [attempt("a1", 1, "change_ready")],
      changeRequests: [cr("cr1", "a1", "pending_review", { requiresExtraReview: true, extraReviewApprovedAt: T(3) })],
    }),
    shape: { code: "active/student" },
    summary: { code: "变更待审阅发布" },
    next: { text: "学生需审阅并发布代理 #1 的变更", owner: "student", target: { kind: "changeRequest", taskId: "task_1", changeRequestId: "cr1" } },
  },
  {
    name: "pending review takes precedence over a newer running attempt",
    input: input({
      attempts: [attempt("a1", 1, "change_ready"), attempt("a2", 8, "running")],
      changeRequests: [cr("cr1", "a1", "pending_review")],
    }),
    shape: { code: "active/student" },
    nextText: "学生需审阅并发布代理 #1 的变更",
  },
  {
    name: "publishing → working",
    input: input({ attempts: [attempt("a1", 1, "change_ready")], changeRequests: [cr("cr1", "a1", "publishing")] }),
    shape: { code: "working/agent" },
    summary: { code: "变更正在发布为 PR" },
    next: { text: "正在将代理 #1 的变更发布为 PR", owner: "agent", target: { kind: "changeRequest", taskId: "task_1", changeRequestId: "cr1" } },
  },
  {
    name: "PR open → code done, register a run next",
    input: input({ attempts: [attempt("a1", 1, "change_ready")], changeRequests: [cr("cr1", "a1", "open", { prNumber: 12 })] }),
    shape: { code: "done/-", run: "active/student" },
    summary: { code: "PR #12 已开启", run: "待登记运行" },
    next: { text: "学生可以登记运行", owner: "student", target: { kind: "task", taskId: "task_1" } },
    current: "run",
  },
  {
    name: "PR merged without number",
    input: input({ attempts: [attempt("a1", 1, "change_ready")], changeRequests: [cr("cr1", "a1", "merged")] }),
    shape: { code: "done/-" },
    summary: { code: "变更已合并" },
  },
  {
    name: "PR merged with number",
    input: input({ attempts: [attempt("a1", 1, "change_ready")], changeRequests: [cr("cr1", "a1", "merged", { prNumber: 7 })] }),
    summary: { code: "PR #7 已合并" },
  },
  {
    name: "change rejected → failed, student",
    input: input({ attempts: [attempt("a1", 1, "change_ready")], changeRequests: [cr("cr1", "a1", "rejected")] }),
    shape: { code: "failed/student", run: "idle/-" },
    summary: { code: "代理 #1 的变更已驳回" },
    next: { text: "代理 #1 的变更已驳回，学生可修订任务或重新交给代理", owner: "student", target: { kind: "changeRequest", taskId: "task_1", changeRequestId: "cr1" } },
  },
  {
    name: "publish failed → failed, student",
    input: input({ attempts: [attempt("a1", 1, "change_ready")], changeRequests: [cr("cr1", "a1", "failed")] }),
    shape: { code: "failed/student" },
    summary: { code: "PR 发布失败" },
    nextText: "代理 #1 的变更发布失败，学生需重试发布",
  },
  {
    name: "canceled latest attempt is passed over; the earlier open PR still counts",
    input: input({
      attempts: [attempt("a1", 1, "change_ready"), attempt("a2", 5, "canceled")],
      changeRequests: [cr("cr1", "a1", "open", { prNumber: 4 })],
    }),
    shape: { code: "done/-", run: "active/student" },
    summary: { code: "PR #4 已开启" },
  },
  {
    name: "only a canceled attempt → back to hand-off choice",
    input: input({ attempts: [attempt("a1", 1, "canceled")] }),
    shape: { code: "active/student" },
  },
  {
    name: "code is optional: runs without attempts → code skipped",
    input: input({ runs: [run("r1", 2, "running")] }),
    shape: { code: "skipped/-", run: "working/lab" },
  },
  {
    name: "code failure followed by a direct run is no longer the blocker",
    input: input({
      attempts: [attempt("a1", 1, "failed", { errorMessage: "测试失败" })],
      runs: [run("r1", 10, "running")],
    }),
    shape: { code: "skipped/-", run: "working/lab" },
    summary: { code: "代理 #1 未产出可用修改，已直接登记运行" },
  },
  {
    name: "code failure after the last run stays failed and leads when nothing else is busy",
    input: input({
      attempts: [attempt("a1", 1, "change_ready"), attempt("a2", 20, "failed", { errorMessage: "测试失败" })],
      changeRequests: [cr("cr1", "a1", "open", { prNumber: 3 })],
      runs: [run("r1", 10, "failed", { changeRequestId: "cr1", failureReason: "显存不足" })],
    }),
    shape: { code: "failed/student", run: "failed/student" },
    nextText: "学生需处理代理 #2 的失败：测试失败",
    current: "code",
  },
  {
    name: "run awaiting approval → mentor, numbered per task",
    input: input({
      attempts: [attempt("a1", 1, "change_ready")],
      changeRequests: [cr("cr1", "a1", "open", { prNumber: 12 })],
      runs: [
        run("r1", 10, "failed", { failureReason: "x" }),
        run("r2", 11, "canceled"),
        run("r3", 12, "awaiting_approval", { changeRequestId: "cr1" }),
      ],
    }),
    shape: { code: "done/-", run: "active/mentor", result: "idle/-" },
    summary: { run: "运行 #3 待导师批准" },
    next: { text: "等待导师批准运行 #3", owner: "mentor", target: { kind: "run", taskId: "task_1", runId: "r3" } },
    current: "run",
  },
  {
    name: "approval-pending run takes precedence over a newer running one",
    input: input({
      runs: [run("r2", 20, "running"), run("r1", 10, "awaiting_approval")],
    }),
    shape: { run: "active/mentor" },
    next: { text: "等待导师批准运行 #1", owner: "mentor", target: { kind: "run", taskId: "task_1", runId: "r1" } },
  },
  ...["queued", "dispatching", "running", "collecting", "cancel_requested"].map((status) => ({
    name: `run ${status} → lab working`,
    input: input({ runs: [run("r1", 10, status)] }),
    shape: { run: "working/lab", result: "idle/-" },
    nextOwner: "lab",
    nextTarget: { kind: "run", taskId: "task_1", runId: "r1" },
    current: "run",
  })),
  {
    name: "queued run wording",
    input: input({ runs: [run("r1", 10, "queued")] }),
    summary: { run: "运行 #1 已批准，排队中" },
    nextText: "运行 #1 已批准，等待实验室执行",
  },
  {
    name: "reconciling → working, no duplicate submission",
    input: input({ runs: [run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "accepted" }), run("r2", 11, "reconciling")] }),
    shape: { run: "working/lab", result: "done/-", next: "idle/-" },
    next: { text: "正在与实验室核对运行 #2 的作业状态，不会重复提交", owner: "lab", target: { kind: "run", taskId: "task_1", runId: "r2" } },
  },
  {
    name: "latest run failed → student, with failure reason",
    input: input({ runs: [run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "accepted" }), run("r2", 11, "failed", { failureReason: "镜像拉取失败" })] }),
    shape: { run: "failed/student", result: "done/-", next: "idle/-" },
    summary: { run: "运行 #2 失败：镜像拉取失败" },
    next: { text: "学生需查看运行 #2 的失败原因：镜像拉取失败", owner: "student", target: { kind: "run", taskId: "task_1", runId: "r2" } },
    current: "run",
  },
  {
    name: "canceled only run, code skipped → student may register again",
    input: input({ runs: [run("r1", 10, "canceled")] }),
    shape: { code: "skipped/-", run: "active/student" },
    summary: { run: "运行 #1 已取消，可重新登记" },
    nextText: "运行 #1 已取消，学生可以重新登记运行",
  },
  {
    name: "canceled latest run with an earlier completed one → run done from the completed one",
    input: input({ runs: [run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "pending" }), run("r2", 11, "canceled")] }),
    shape: { run: "done/-", result: "active/mentor" },
    summary: { run: "运行 #1 执行结束" },
  },
  {
    name: "canceled run while code is still running → idle run",
    input: input({ attempts: [attempt("a1", 1, "running")], runs: [run("r1", 10, "canceled")] }),
    shape: { code: "working/agent", run: "idle/-" },
    summary: { run: "运行 #1 已取消" },
  },
  {
    name: "completed, review pending → mentor reviews; validity worded separately",
    input: input({ runs: [run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "pending" })] }),
    shape: { run: "done/-", result: "active/mentor", next: "idle/-" },
    summary: { run: "运行 #1 执行结束", result: "运行 #1 技术有效 · 待导师评审" },
    next: { text: "等待导师评审运行 #1", owner: "mentor", target: { kind: "run", taskId: "task_1", runId: "r1" } },
    current: "result",
  },
  {
    name: "completed with unknown validity and no review row yet → still awaiting mentor review",
    input: input({ runs: [run("r1", 10, "completed", { technicalValidity: "unknown" })] }),
    shape: { result: "active/mentor" },
    summary: { result: "运行 #1 技术有效性未知 · 待导师评审" },
  },
  {
    name: "technically invalid, unreviewed → active: the mentor must still review, worded as invalid",
    input: input({ runs: [run("r1", 10, "completed", { technicalValidity: "invalid", reviewState: "pending" })] }),
    shape: { result: "active/mentor", next: "idle/-" },
    summary: { result: "运行 #1 技术无效 · 待导师评审" },
    next: { text: "等待导师评审运行 #1（技术无效，不能验收）", owner: "mentor", target: { kind: "run", taskId: "task_1", runId: "r1" } },
    current: "result",
  },
  {
    name: "technically invalid and rejected → done",
    input: input({ runs: [run("r1", 10, "completed", { technicalValidity: "invalid", reviewState: "rejected" })] }),
    shape: { result: "done/-", next: "active/student" },
    summary: { result: "运行 #1 技术无效 · 导师未采纳", next: "决定：修订任务、转为下一轮或关闭" },
    nextText: "运行 #1 未采纳，学生或导师决定：修订任务、转为下一轮或关闭",
  },
  {
    name: "accepted → result done, next: decide follow-up or close",
    input: input({ runs: [run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "accepted" })] }),
    shape: { run: "done/-", result: "done/-", next: "active/student" },
    summary: { result: "运行 #1 技术有效 · 导师已验收", next: "决定：转为下一轮任务或完成并关闭" },
    next: { text: "运行 #1 已验收，学生或导师决定：转为下一轮任务或完成并关闭", owner: "student", target: { kind: "run", taskId: "task_1", runId: "r1" } },
    current: "next",
  },
  {
    name: "needs_followup → next: turn into a follow-up task",
    input: input({ runs: [run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "needs_followup" })] }),
    shape: { result: "done/-", next: "active/student" },
    summary: { result: "运行 #1 技术有效 · 需要后续实验", next: "转为下一轮任务" },
    nextText: "运行 #1 需要后续实验，学生或导师可转为下一轮任务",
    current: "next",
  },
  {
    name: "older run awaiting review outranks the newest accepted run",
    input: input({
      runs: [
        run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "pending" }),
        run("r2", 11, "completed", { technicalValidity: "valid", reviewState: "accepted" }),
      ],
    }),
    shape: { result: "active/mentor", next: "active/student" },
    nextText: "等待导师评审运行 #1",
    current: "result",
  },
  {
    name: "accepted run but a newer run is awaiting approval → next stage waits",
    input: input({
      runs: [
        run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "accepted" }),
        run("r2", 11, "awaiting_approval"),
      ],
    }),
    shape: { run: "active/mentor", result: "done/-", next: "idle/-" },
    nextText: "等待导师批准运行 #2",
  },
  {
    name: "closed task → all done, no next step",
    input: input({
      task: task({ status: "closed" }),
      runs: [run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "accepted" })],
    }),
    shape: { task: "done/-", code: "skipped/-", run: "done/-", result: "done/-", next: "done/-" },
    summary: { task: "任务已关闭", next: "任务已关闭" },
    next: null,
    current: "next",
  },
  {
    name: "closed task with a run still awaiting approval: nothing is asked of anyone",
    input: input({ task: task({ status: "closed" }), runs: [run("r1", 10, "awaiting_approval")] }),
    shape: { run: "skipped/-", next: "done/-" },
    next: null,
  },
  {
    name: "canceled draft → later stages skipped, no next",
    input: input({ task: task({ status: "canceled", confirmedVersion: null, currentVersion: 1 }) }),
    shape: { task: "done/-", code: "skipped/-", run: "skipped/-", result: "skipped/-", next: "skipped/-" },
    summary: { task: "任务已取消", code: "任务已取消" },
    next: null,
    current: "task",
  },
  {
    name: "canceled confirmed task keeps recorded failures but asks nothing",
    input: input({
      task: task({ status: "canceled" }),
      attempts: [attempt("a1", 1, "failed", { errorMessage: "x" })],
    }),
    shape: { code: "failed/student", run: "skipped/-", next: "skipped/-" },
    next: null,
    current: "code",
  },
  {
    name: "partial input (attempts not loaded), no runs → flagged partial, code idle",
    input: input({ attempts: null, changeRequests: null }),
    partial: true,
    shape: { task: "done/-", code: "idle/-", run: "idle/-" },
    summary: { code: "代码详情加载中" },
    next: null,
    current: "task",
  },
  {
    name: "partial input, run using a change request → code done from runs alone",
    input: input({ attempts: null, changeRequests: null, runs: [run("r1", 10, "awaiting_approval", { changeRequestId: "cr1" })] }),
    partial: true,
    shape: { code: "done/-", run: "active/mentor" },
    nextText: "等待导师批准运行 #1",
  },
  {
    name: "partial input (only change requests missing), direct run → code skipped",
    input: input({ changeRequests: null, attempts: [attempt("a1", 1, "running")], runs: [run("r1", 10, "running")] }),
    partial: true,
    shape: { code: "skipped/-", run: "working/lab" },
    nextText: "等待实验室完成运行 #1",
  },
  {
    name: "partial draft task → task confirmation still leads",
    input: input({ task: task({ status: "draft", confirmedVersion: null, currentVersion: 1 }), attempts: null, changeRequests: null }),
    partial: true,
    shape: { task: "active/student", code: "idle/-" },
    nextText: "学生需确认第 1 版任务（导师也可确认）",
  },
];

for (const item of cases) {
  test(`stage model: ${item.name}`, () => {
    const result = computeTaskStages(item.input);
    assert.deepEqual(result.stages.map((s) => s.key), ["task", "code", "run", "result", "next"]);
    for (const s of result.stages) assert.equal(s.label, STAGE_LABELS[s.key]);
    assert.equal(result.partial, item.partial ?? false, "partial");
    if (item.shape) {
      const actual = shape(result);
      for (const [key, value] of Object.entries(item.shape)) assert.equal(actual[key], value, `stage ${key}`);
    }
    for (const [key, text] of Object.entries(item.summary ?? {})) assert.equal(stage(result, key).summary, text, `summary ${key}`);
    if ("next" in item) assert.deepEqual(result.next, item.next);
    if (item.nextText) assert.equal(result.next?.text, item.nextText);
    if (item.nextOwner) assert.equal(result.next?.owner, item.nextOwner);
    if (item.nextTarget) assert.deepEqual(result.next?.target, item.nextTarget);
    if (item.current) assert.equal(result.current, item.current, "current");
  });
}

test("stage model: invariants hold across every case", () => {
  for (const item of cases) {
    const result = computeTaskStages(item.input);
    for (const s of result.stages) {
      if (s.state === "active" || s.state === "working") assert.ok(s.owner, `${item.name}: ${s.key} needs an owner`);
      if (s.state === "done" || s.state === "idle" || s.state === "skipped") assert.equal(s.owner, null, `${item.name}: ${s.key} owner`);
      // Validity and review are never collapsed into a single success word.
      assert.doesNotMatch(s.summary, /成功/, `${item.name}: ${s.key}`);
    }
    const nextStage = result.next && result.stages.find((s) => s.key === result.current);
    if (result.next) {
      assert.ok(["active", "working", "failed"].includes(nextStage.state), `${item.name}: next comes from an actionable stage`);
      assert.equal(result.next.owner, nextStage.owner, `${item.name}: next owner matches its stage`);
      const firstActive = result.stages.find((s) => s.state === "active");
      if (firstActive) assert.equal(result.current, firstActive.key, `${item.name}: earliest active stage leads`);
    }
    if (["closed", "canceled"].includes(item.input.task.status)) assert.equal(result.next, null);
  }
});

test("stage model: deterministic and independent of input order and the clock", () => {
  const runs = [
    run("r1", 10, "completed", { technicalValidity: "valid", reviewState: "accepted" }),
    run("r2", 11, "failed", { failureReason: "x" }),
    run("r3", 12, "awaiting_approval"),
  ];
  const a = computeTaskStages(input({ runs }));
  const b = computeTaskStages(input({ runs: [...runs].reverse() }));
  assert.deepEqual(a, b);
  const realNow = Date.now;
  try {
    Date.now = () => 0;
    assert.deepEqual(computeTaskStages(input({ runs })), a);
  } finally {
    Date.now = realNow;
  }
  assert.equal(a.next.text, "等待导师批准运行 #3");
});

test("stage model: long failure messages are shortened in summaries", () => {
  const message = "x".repeat(200);
  const result = computeTaskStages(input({ attempts: [attempt("a1", 1, "failed", { errorMessage: message })] }));
  const summary = stage(result, "code").summary;
  assert.ok(summary.length < 60, summary);
  assert.ok(summary.endsWith("…"));
});
