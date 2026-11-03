// Independent scenario suite for the task stage model (frontend plan F1).
// Derived from docs/科研闭环_前端优化方案_2026-11-03.md §一/§四 F1 and the design
// pack (02 §6, 01 "technical success ≠ hypothesis outcome ≠ human acceptance",
// "failed runs stay visible") — not from any implementation. Assertions pin
// behaviour (state, owner, current, next.owner, next.target) and only check
// that next.text names the right object, never full sentences.
import assert from "node:assert/strict";
import test from "node:test";
import { STAGE_LABELS, computeTaskStages } from "../components/research-loop/stage-model.ts";

const STAGE_KEYS = ["task", "code", "run", "result", "next"];
const STATES = ["done", "active", "working", "failed", "idle", "skipped"];
const OWNERS = ["student", "mentor", "reviewer", "admin", "agent", "lab", null];
const HUMANS = ["student", "mentor", "reviewer", "admin"];
const TASK_ID = "task_scn";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const at = (minute) => new Date(Date.UTC(2026, 10, 3, 8, minute)).toISOString();

function task(overrides = {}) {
  return {
    id: TASK_ID, studentId: "stu_1", title: "数据增强对小样本缺陷检测的影响", status: "confirmed",
    currentVersion: 2, confirmedVersion: 2, sourceGuidanceNoteId: 7, sourceRunId: null, parentTaskId: null,
    createdByUserId: 11, createdAt: at(0), updatedAt: at(1), ...overrides,
  };
}

function attempt(id, status, minute, overrides = {}) {
  return {
    id, taskVersion: 2, provider: "codex", modelId: "gpt-x", status, baseCommitSha: "a".repeat(40),
    errorCode: status === "failed" ? "agent_error" : "", errorMessage: status === "failed" ? "测试未通过" : "",
    requestedByUserId: 21, createdAt: at(minute), startedAt: at(minute), endedAt: null, updatedAt: at(minute), ...overrides,
  };
}

function changeRequest(id, attemptId, status, overrides = {}) {
  return { id, attemptId, status, requiresExtraReview: false, extraReviewApprovedAt: null, prNumber: null, ...overrides };
}

function run(id, status, minute, overrides = {}) {
  const terminal = ["completed", "failed", "canceled"].includes(status);
  return {
    id, attempt: 1, status, taskId: TASK_ID, studentId: "stu_1", runSpecSha256: "b".repeat(64),
    approvalId: status === "awaiting_approval" ? null : `appr_${id}`, submitTag: `tag_${id}`, runnerId: "runner_1",
    exitCode: status === "completed" ? 0 : status === "failed" ? 1 : null,
    failureReason: status === "failed" ? "CUDA out of memory" : "", cancelRequestedAt: null, createdByUserId: 21,
    createdAt: at(minute), queuedAt: null, startedAt: null, endedAt: terminal ? at(minute + 5) : null,
    executedCommitSha: "c".repeat(40), entrypointId: "ep_train", datasetVersionId: "ds_v3", changeRequestId: "cr_1",
    technicalValidity: status === "completed" ? "valid" : null, reviewState: null, ...overrides,
  };
}

/** A confirmed task whose code is merged, ready for runs. */
function withMergedCode(runs, overrides = {}) {
  return {
    task: task(overrides.task),
    attempts: [attempt("att_1", "change_ready", 2)],
    changeRequests: [changeRequest("cr_1", "att_1", "merged", { prNumber: 12 })],
    runs,
  };
}

const stage = (result, key) => result.stages.find((item) => item.key === key);
const anyActive = (result) => result.stages.some((item) => item.state === "active");

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Creation-order number of a run, computed independently of the model. */
function runNumber(runs, id) {
  const sorted = [...runs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  return sorted.findIndex((item) => item.id === id) + 1;
}

function assertRunTarget(result, input, runId) {
  assert.ok(result.next, "expected a next step");
  assert.deepEqual(result.next.target, { kind: "run", taskId: TASK_ID, runId });
  const number = runNumber(input.runs, runId);
  assert.ok(result.next.text.includes(`运行 #${number}`), `next.text should name 运行 #${number}: ${result.next.text}`);
  for (const other of input.runs) {
    if (other.id === runId) continue;
    const otherNumber = runNumber(input.runs, other.id);
    assert.ok(!result.next.text.includes(`运行 #${otherNumber}`), `next.text must not name 运行 #${otherNumber}: ${result.next.text}`);
  }
}

/** Structural contract every output must satisfy. */
function assertWellFormed(result, input, label = "") {
  assert.equal(result.stages.length, 5, label);
  assert.deepEqual(result.stages.map((item) => item.key), STAGE_KEYS, label);
  for (const item of result.stages) {
    assert.equal(item.label, STAGE_LABELS[item.key], label);
    assert.ok(STATES.includes(item.state), `${label} state ${item.state}`);
    assert.ok(OWNERS.includes(item.owner), `${label} owner ${item.owner}`);
    assert.equal(typeof item.summary, "string", label);
  }
  assert.ok(STAGE_KEYS.includes(result.current), `${label} current ${result.current}`);
  assert.equal(typeof result.partial, "boolean", label);
  if (result.next !== null) {
    assert.equal(typeof result.next.text, "string", label);
    assert.ok(result.next.text.length > 0, `${label} next.text empty`);
    assert.ok(OWNERS.includes(result.next.owner), `${label} next.owner ${result.next.owner}`);
    const target = result.next.target;
    if (target !== null) {
      assert.equal(target.taskId, input.task.id, label);
      if (target.kind === "run") assert.ok(input.runs.some((item) => item.id === target.runId), `${label} unknown run target`);
      else if (target.kind === "attempt") assert.ok((input.attempts ?? []).some((item) => item.id === target.attemptId), `${label} unknown attempt target`);
      else if (target.kind === "changeRequest") assert.ok((input.changeRequests ?? []).some((item) => item.id === target.changeRequestId), `${label} unknown change request target`);
      else assert.equal(target.kind, "task", label);
    }
  }
}

function compute(input, label) {
  const result = computeTaskStages(input);
  assertWellFormed(result, input, label);
  return result;
}

// ---------------------------------------------------------------------------
// G1 — task confirmation
// ---------------------------------------------------------------------------

test("G1: a fresh draft makes the task stage active and points at the task", () => {
  const input = { task: task({ status: "draft", currentVersion: 1, confirmedVersion: null }), attempts: [], changeRequests: [], runs: [] };
  const result = compute(input);
  assert.equal(stage(result, "task").state, "active");
  assert.ok(["student", "mentor"].includes(stage(result, "task").owner), "student or mentor confirms (plan §1.3 G1)");
  assert.equal(result.current, "task");
  assert.ok(result.next);
  assert.ok(["student", "mentor"].includes(result.next.owner));
  assert.deepEqual(result.next.target, { kind: "task", taskId: TASK_ID });
  for (const key of ["code", "run", "result", "next"]) assert.ok(["idle", "skipped"].includes(stage(result, key).state), key);
  assert.equal(result.partial, false);
});

test("G1: a revised draft after an earlier confirmation is active again and names the new version", () => {
  const input = {
    task: task({ status: "draft", currentVersion: 3, confirmedVersion: 2 }),
    attempts: [attempt("att_1", "change_ready", 2)],
    changeRequests: [changeRequest("cr_1", "att_1", "merged", { prNumber: 12 })],
    runs: [run("run_1", "completed", 10, { reviewState: "needs_followup" })],
  };
  const result = compute(input);
  assert.equal(stage(result, "task").state, "active");
  assert.equal(result.current, "task");
  assert.ok(result.next);
  assert.ok(["student", "mentor"].includes(result.next.owner));
  assert.deepEqual(result.next.target, { kind: "task", taskId: TASK_ID });
  assert.match(result.next.text, /3/, "next step should refer to version 3");
});

test("G1: a confirmed task is done at the task stage", () => {
  const result = compute({ task: task(), attempts: [], changeRequests: [], runs: [] });
  assert.equal(stage(result, "task").state, "done");
  assert.equal(stage(result, "task").owner, null);
  assert.notEqual(result.current, "task");
});

// ---------------------------------------------------------------------------
// Code stage — agent attempts and change requests (G2)
// ---------------------------------------------------------------------------

test("a running agent makes the code stage working (agent), and no human is asked to act", () => {
  const input = { task: task(), attempts: [attempt("att_1", "running", 2)], changeRequests: [], runs: [] };
  const result = compute(input);
  assert.equal(stage(result, "code").state, "working");
  assert.equal(stage(result, "code").owner, "agent");
  assert.equal(result.current, "code");
  assert.equal(anyActive(result), false);
  assert.ok(result.next === null || !HUMANS.includes(result.next.owner), "nobody human should be asked to act");
});

test("a running agent does not hide another stage that needs a human", () => {
  const input = {
    task: task({ currentVersion: 3, confirmedVersion: 3 }),
    attempts: [attempt("att_1", "change_ready", 2), attempt("att_2", "running", 30, { taskVersion: 3 })],
    changeRequests: [changeRequest("cr_1", "att_1", "merged", { prNumber: 12 })],
    runs: [run("run_1", "completed", 10, { reviewState: "pending" })],
  };
  const result = compute(input);
  assert.equal(stage(result, "result").state, "active");
  assert.equal(stage(result, "result").owner, "mentor");
  assert.equal(result.next.owner, "mentor");
  assertRunTarget(result, input, "run_1");
});

test("G2: a change touching protected paths without extra-review approval waits for the mentor", () => {
  const input = {
    task: task(),
    attempts: [attempt("att_1", "change_ready", 2)],
    changeRequests: [changeRequest("cr_1", "att_1", "pending_review", { requiresExtraReview: true, extraReviewApprovedAt: null })],
    runs: [],
  };
  const result = compute(input);
  assert.equal(stage(result, "code").state, "active");
  assert.equal(stage(result, "code").owner, "mentor");
  assert.equal(result.current, "code");
  assert.equal(result.next.owner, "mentor");
  assert.deepEqual(result.next.target, { kind: "changeRequest", taskId: TASK_ID, changeRequestId: "cr_1" });
});

test("G2: a normal pending change, or one whose extra review is approved, is not mentor-only", () => {
  for (const cr of [
    changeRequest("cr_1", "att_1", "pending_review"),
    changeRequest("cr_1", "att_1", "pending_review", { requiresExtraReview: true, extraReviewApprovedAt: at(5) }),
  ]) {
    const input = { task: task(), attempts: [attempt("att_1", "change_ready", 2)], changeRequests: [cr], runs: [] };
    const result = compute(input);
    assert.equal(stage(result, "code").state, "active");
    assert.notEqual(stage(result, "code").owner, "mentor", "routine review is the reviewer's job (plan §1.2)");
    assert.ok(HUMANS.includes(stage(result, "code").owner));
    assert.equal(result.current, "code");
    assert.ok(result.next && HUMANS.includes(result.next.owner));
    assert.notEqual(result.next.owner, "mentor");
    assert.deepEqual(result.next.target, { kind: "changeRequest", taskId: TASK_ID, changeRequestId: "cr_1" });
  }
});

test("a failed agent attempt shows the code stage as failed", () => {
  const input = { task: task(), attempts: [attempt("att_1", "failed", 2)], changeRequests: [], runs: [] };
  const result = compute(input);
  assert.equal(stage(result, "code").state, "failed");
  assert.equal(result.current, "code");
});

// ---------------------------------------------------------------------------
// Run stage (G3) — approval precedence, reconciling, failures
// ---------------------------------------------------------------------------

test("G3: a run awaiting approval takes precedence over a newer running run", () => {
  // Input order differs from creation order, and ids sort opposite to time.
  const input = withMergedCode([
    run("run_a", "running", 40),
    run("run_z", "failed", 10),
    run("run_m", "awaiting_approval", 20),
  ]);
  const result = compute(input);
  assert.equal(stage(result, "run").state, "active");
  assert.equal(stage(result, "run").owner, "mentor");
  assert.equal(result.current, "run");
  assert.equal(result.next.owner, "mentor");
  assertRunTarget(result, input, "run_m"); // 运行 #2 by creation time
  assert.ok(result.next.text.includes("运行 #2"));
});

test("a running run is lab work; nobody human is asked to act", () => {
  const input = withMergedCode([run("run_1", "running", 10)]);
  const result = compute(input);
  assert.equal(stage(result, "run").state, "working");
  assert.ok(!HUMANS.includes(stage(result, "run").owner));
  assert.equal(result.current, "run");
  assert.ok(result.next === null || !HUMANS.includes(result.next.owner));
});

test("a reconciling run is working, never failed", () => {
  for (const runs of [
    [run("run_1", "reconciling", 10)],
    [run("run_1", "failed", 5), run("run_2", "reconciling", 10)],
  ]) {
    const input = withMergedCode(runs);
    const result = compute(input);
    assert.equal(stage(result, "run").state, "working");
    assert.ok(!HUMANS.includes(stage(result, "run").owner));
    assert.notEqual(stage(result, "result").state, "failed");
    assert.equal(result.current, "run");
  }
});

test("a failed run is visible as failed and nothing claims success", () => {
  const input = withMergedCode([run("run_1", "failed", 10)]);
  const result = compute(input);
  assert.equal(stage(result, "run").state, "failed");
  assert.equal(result.current, "run");
  assert.ok(["idle", "skipped"].includes(stage(result, "result").state));
  assert.ok(["idle", "skipped"].includes(stage(result, "next").state));
  const visible = `${stage(result, "run").summary} ${result.next?.text ?? ""}`;
  assert.match(visible, /失败/, "the failure must be stated, not hidden");
  if (result.next?.target?.kind === "run") assertRunTarget(result, input, "run_1");
});

test("a later completed run reflects the latest state but never credits the earlier failed run", () => {
  const input = withMergedCode([
    run("run_2", "completed", 30, { reviewState: "pending" }),
    run("run_1", "failed", 10),
  ]);
  const result = compute(input);
  assert.notEqual(stage(result, "run").state, "failed", "run stage reflects the latest run");
  assert.notEqual(stage(result, "run").state, "active");
  assert.equal(stage(result, "result").state, "active");
  assert.equal(result.next.owner, "mentor");
  assertRunTarget(result, input, "run_2"); // reviewing 运行 #2, not the failed 运行 #1
});

// ---------------------------------------------------------------------------
// Result stage (G4) — technical validity vs. human acceptance
// ---------------------------------------------------------------------------

test("G4: a completed run pending review makes the result stage active for the mentor", () => {
  for (const reviewState of ["pending", null]) {
    const input = withMergedCode([run("run_1", "completed", 10, { reviewState })]);
    const result = compute(input, `reviewState=${reviewState}`);
    assert.equal(stage(result, "run").state, "done");
    assert.equal(stage(result, "result").state, "active");
    assert.equal(stage(result, "result").owner, "mentor");
    assert.equal(result.current, "result");
    assert.equal(result.next.owner, "mentor");
    assertRunTarget(result, input, "run_1");
    assert.ok(["idle", "skipped"].includes(stage(result, "next").state));
  }
});

test("G4: invalid or unknown technical validity is never reported as done or accepted", () => {
  for (const technicalValidity of ["invalid", "unknown"]) {
    const input = withMergedCode([run("run_1", "completed", 10, { technicalValidity, reviewState: "pending" })]);
    const result = compute(input, technicalValidity);
    assert.notEqual(stage(result, "result").state, "done");
    assert.equal(stage(result, "result").state, "active", "the mentor still has to review it");
    assert.notEqual(stage(result, "next").state, "done");
    for (const item of result.stages) assert.doesNotMatch(item.summary, /已采纳|已接受/, `${item.key}: ${item.summary}`);
    assert.doesNotMatch(result.next?.text ?? "", /已采纳|已接受/);
  }
});

test("G4: accepted or needs_followup closes the result stage and opens the next round", () => {
  for (const reviewState of ["accepted", "needs_followup"]) {
    const input = withMergedCode([run("run_1", "completed", 10, { reviewState })]);
    const result = compute(input, reviewState);
    assert.equal(stage(result, "result").state, "done");
    assert.equal(stage(result, "result").owner, null);
    assert.equal(stage(result, "next").state, "active");
    assert.ok(HUMANS.includes(stage(result, "next").owner));
    assert.equal(result.current, "next");
    assert.ok(result.next && HUMANS.includes(result.next.owner));
    if (result.next.target?.kind === "run") assertRunTarget(result, input, "run_1");
    else assert.deepEqual(result.next.target, { kind: "task", taskId: TASK_ID });
  }
});

// ---------------------------------------------------------------------------
// Terminal tasks
// ---------------------------------------------------------------------------

test("a closed task has no next step and nobody is asked to act", () => {
  const input = withMergedCode([run("run_1", "completed", 10, { reviewState: "accepted" })], { task: { status: "closed" } });
  const result = compute(input);
  assert.equal(result.next, null);
  assert.equal(anyActive(result), false);
  assert.ok(result.stages.every((item) => item.state !== "working"));
});

test("a canceled draft skips every later stage", () => {
  const input = { task: task({ status: "canceled", currentVersion: 1, confirmedVersion: null }), attempts: [], changeRequests: [], runs: [] };
  const result = compute(input);
  assert.equal(result.next, null);
  assert.equal(anyActive(result), false);
  for (const key of ["code", "run", "result", "next"]) assert.equal(stage(result, key).state, "skipped", key);
});

test("a task canceled after code was produced skips the stages it never reached", () => {
  const input = {
    task: task({ status: "canceled" }),
    attempts: [attempt("att_1", "change_ready", 2)],
    changeRequests: [changeRequest("cr_1", "att_1", "merged", { prNumber: 12 })],
    runs: [],
  };
  const result = compute(input);
  assert.equal(result.next, null);
  assert.equal(anyActive(result), false);
  for (const key of ["run", "result", "next"]) assert.equal(stage(result, key).state, "skipped", key);
  assert.notEqual(stage(result, "code").state, "skipped", "the code stage was reached");
});

// ---------------------------------------------------------------------------
// Partial input, determinism
// ---------------------------------------------------------------------------

test("partial input (attempts/changeRequests not loaded) is flagged and does not throw", () => {
  for (const [attempts, changeRequests] of [[null, null], [null, []], [[], null]]) {
    const input = { task: task(), attempts, changeRequests, runs: [] };
    const result = compute(input);
    assert.equal(result.partial, true);
  }
  const full = compute({ task: task(), attempts: [], changeRequests: [], runs: [] });
  assert.equal(full.partial, false);
});

test("partial input still derives run-stage decisions from the runs it has", () => {
  const input = { task: task(), attempts: null, changeRequests: null, runs: [run("run_1", "awaiting_approval", 10)] };
  const result = compute(input);
  assert.equal(result.partial, true);
  assert.equal(stage(result, "run").state, "active");
  assert.equal(result.next.owner, "mentor");
  assertRunTarget(result, input, "run_1");
});

test("same input gives identical output, inputs are not mutated, and input order does not matter", () => {
  const build = () => ({
    task: task(),
    attempts: [attempt("att_1", "failed", 2), attempt("att_2", "change_ready", 4)],
    changeRequests: [changeRequest("cr_1", "att_2", "merged", { prNumber: 12 })],
    runs: [run("run_3", "awaiting_approval", 40), run("run_1", "failed", 10), run("run_2", "completed", 20, { reviewState: "accepted" })],
  });
  const input = deepFreeze(build());
  const snapshot = JSON.stringify(input);
  const first = computeTaskStages(input);
  const second = computeTaskStages(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot);

  const reordered = build();
  reordered.runs.reverse();
  reordered.attempts.reverse();
  assert.deepEqual(computeTaskStages(deepFreeze(reordered)), first);
});

// ---------------------------------------------------------------------------
// Invariants over generated combinations
// ---------------------------------------------------------------------------

const TASK_VARIANTS = {
  draftNew: { status: "draft", currentVersion: 1, confirmedVersion: null },
  draftRevised: { status: "draft", currentVersion: 3, confirmedVersion: 2 },
  confirmed: { status: "confirmed", currentVersion: 2, confirmedVersion: 2 },
  closed: { status: "closed", currentVersion: 2, confirmedVersion: 2 },
  canceled: { status: "canceled", currentVersion: 2, confirmedVersion: 2 },
};

const ATTEMPT_VARIANTS = {
  none: [],
  queued: [attempt("att_1", "queued", 2)],
  running: [attempt("att_1", "running", 2)],
  failed: [attempt("att_1", "failed", 2)],
  ready: [attempt("att_1", "change_ready", 2)],
  failedThenReady: [attempt("att_0", "failed", 1), attempt("att_1", "change_ready", 2)],
  readyThenRunning: [attempt("att_1", "change_ready", 2), attempt("att_2", "running", 3)],
};

const CR_VARIANTS = {
  none: [],
  pending: [changeRequest("cr_1", "att_1", "pending_review")],
  protectedPending: [changeRequest("cr_1", "att_1", "pending_review", { requiresExtraReview: true })],
  protectedApproved: [changeRequest("cr_1", "att_1", "pending_review", { requiresExtraReview: true, extraReviewApprovedAt: at(4) })],
  publishing: [changeRequest("cr_1", "att_1", "publishing")],
  open: [changeRequest("cr_1", "att_1", "open", { prNumber: 12 })],
  merged: [changeRequest("cr_1", "att_1", "merged", { prNumber: 12 })],
  rejected: [changeRequest("cr_1", "att_1", "rejected")],
};

const RUN_VARIANTS = {
  none: [],
  awaiting: [run("run_1", "awaiting_approval", 10)],
  queued: [run("run_1", "queued", 10)],
  running: [run("run_1", "running", 10)],
  reconciling: [run("run_1", "reconciling", 10)],
  failed: [run("run_1", "failed", 10)],
  pending: [run("run_1", "completed", 10, { reviewState: "pending" })],
  unreviewed: [run("run_1", "completed", 10, { reviewState: null })],
  invalidPending: [run("run_1", "completed", 10, { technicalValidity: "invalid", reviewState: "pending" })],
  accepted: [run("run_1", "completed", 10, { reviewState: "accepted" })],
  followup: [run("run_1", "completed", 10, { reviewState: "needs_followup" })],
  rejected: [run("run_1", "completed", 10, { reviewState: "rejected" })],
  failedThenPending: [run("run_2", "completed", 20, { reviewState: "pending" }), run("run_1", "failed", 10)],
  awaitingThenRunning: [run("run_2", "running", 20), run("run_1", "awaiting_approval", 10)],
  acceptedThenAwaiting: [run("run_1", "completed", 10, { reviewState: "accepted" }), run("run_2", "awaiting_approval", 20)],
};

function* combinations() {
  for (const [taskName, taskFields] of Object.entries(TASK_VARIANTS)) {
    for (const [attemptName, attempts] of Object.entries(ATTEMPT_VARIANTS)) {
      for (const [crName, changeRequests] of Object.entries(CR_VARIANTS)) {
        for (const [runName, runs] of Object.entries(RUN_VARIANTS)) {
          const neverConfirmed = taskFields.confirmedVersion === null;
          if (neverConfirmed && (attempts.length || changeRequests.length || runs.length)) continue;
          if (changeRequests.length && !attempts.some((item) => item.id === "att_1" && item.status === "change_ready")) continue;
          for (const partial of [false, true]) {
            if (partial && (attemptName !== "none" || crName !== "none")) continue;
            yield {
              label: `${taskName}/${attemptName}/${crName}/${runName}${partial ? "/partial" : ""}`,
              input: {
                task: task(taskFields),
                attempts: partial ? null : attempts.map((item) => ({ ...item })),
                changeRequests: partial ? null : changeRequests.map((item) => ({ ...item })),
                runs: runs.map((item) => ({ ...item })),
              },
            };
          }
        }
      }
    }
  }
}

test("invariants hold across generated combinations", () => {
  let count = 0;
  for (const { label, input } of combinations()) {
    count += 1;
    const snapshot = JSON.stringify(input);
    const result = compute(input, label);
    assert.equal(JSON.stringify(input), snapshot, `${label}: input mutated`);
    assert.deepEqual(computeTaskStages(input), result, `${label}: not deterministic`);
    assert.equal(result.partial, input.attempts === null || input.changeRequests === null, `${label}: partial`);

    const current = stage(result, result.current);
    const active = result.stages.filter((item) => item.state === "active");

    // Owners match state semantics.
    for (const item of result.stages) {
      if (["done", "idle", "skipped"].includes(item.state)) assert.equal(item.owner, null, `${label}: ${item.key} ${item.state} has owner ${item.owner}`);
      if (item.state === "active") assert.ok(HUMANS.includes(item.owner), `${label}: active ${item.key} needs a human owner`);
      if (item.state === "working") assert.ok(!HUMANS.includes(item.owner), `${label}: working ${item.key} owned by ${item.owner}`);
    }

    // Exactly one current stage, and it is a stage needing action whenever one does.
    if (active.length) {
      assert.equal(current.state, "active", `${label}: current ${result.current} is ${current.state} while a stage is active`);
      assert.ok(result.next, `${label}: an active stage needs a next step`);
      assert.ok(HUMANS.includes(result.next.owner), `${label}: next.owner ${result.next.owner}`);
      assert.equal(result.next.owner, current.owner, `${label}: next.owner differs from current stage owner`);
    }
    // next.owner is null only when nothing needs a human.
    if (result.next && result.next.owner === null) assert.equal(active.length, 0, `${label}: null next.owner with an active stage`);
    if (result.next?.target?.kind === "run") assertRunTarget(result, input, result.next.target.runId);

    // Terminal tasks.
    if (["closed", "canceled"].includes(input.task.status)) {
      assert.equal(result.next, null, `${label}: terminal task has a next step`);
      assert.equal(active.length, 0, `${label}: terminal task has an active stage`);
    }
    if (input.task.status === "canceled" && input.runs.length === 0) {
      for (const key of ["run", "result", "next"]) assert.equal(stage(result, key).state, "skipped", `${label}: ${key}`);
    }
    if (input.task.status === "draft") assert.equal(stage(result, "task").state, "active", `${label}: draft task`);

    // Failure is only reported where something failed; reconciling is not failure.
    const latestRun = [...input.runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (!input.runs.some((item) => item.status === "failed")) assert.notEqual(stage(result, "run").state, "failed", `${label}: run failed without a failed run`);
    if (latestRun?.status === "reconciling") {
      assert.notEqual(stage(result, "run").state, "failed", `${label}: reconciling reported as failed`);
      if (!["closed", "canceled"].includes(input.task.status)) assert.equal(stage(result, "run").state, "working", `${label}: reconciling`);
    }
    const codeFailures = (input.attempts ?? []).some((item) => item.status === "failed")
      || (input.changeRequests ?? []).some((item) => ["rejected", "failed", "closed"].includes(item.status));
    if (!codeFailures) assert.notEqual(stage(result, "code").state, "failed", `${label}: code failed without a failure`);

    // Results are done only after a human review; never from a technical outcome alone.
    const reviewed = input.runs.some((item) => item.status === "completed" && ["accepted", "needs_followup", "rejected"].includes(item.reviewState));
    if (!reviewed) assert.notEqual(stage(result, "result").state, "done", `${label}: result done without review`);
    if (input.runs.length === 0) assert.ok(["idle", "skipped"].includes(stage(result, "result").state), `${label}: result without runs`);
    if (input.runs.some((item) => item.status === "completed" && item.technicalValidity !== "valid")) {
      for (const item of result.stages) assert.doesNotMatch(item.summary, /已采纳|已接受/, `${label}: ${item.key}`);
    }
  }
  assert.ok(count > 300, `expected a broad sweep, got ${count}`);
});
