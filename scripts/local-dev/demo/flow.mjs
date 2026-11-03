// The demo task, and (with --auto) the whole loop driven through the same HTTP
// APIs the browser uses, logged in as the synthetic student and mentor:
// task → confirm → agent attempt → change request → publish PR → run →
// mentor approval → lab runner → result → mentor review.
import { randomUUID } from "node:crypto";

import { FIRST_PR_NUMBER, STUDENT_ID, TASK_TITLE_PREFIX } from "./constants.mjs";

const key = (label) => `demo-${label}-${randomUUID()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const DEMO_TASK = {
  title: `${TASK_TITLE_PREFIX}修正 predict 的缩放（合成）`,
  researchQuestion: "合成数据满足 y = 2x；模型 predict 是否漏了系数 2？",
  hypothesis: "把 predict 改为 2 * x 后，测试划分 accuracy 从 0 提升到 1.0。",
  instructions: "修改 src/model.mjs，使 predict(x) 返回 2 * x，并运行 node --test。不要改动 evaluation/ 与 train.mjs。",
  acceptanceCriteria: "node --test 通过；运行 demo_train_eval 后 metrics.json 中 accuracy = 1.0。",
  allowedPaths: ["src/**", "test/**"],
  budget: { maxAgentMinutes: 10, maxGpuCount: 1, maxWalltimeMinutes: 30 },
};

export async function createDemoTask(api) {
  const created = await api.post("student", "/api/research-tasks", { action: "create", studentId: STUDENT_ID, mutationId: key("task"), ...DEMO_TASK });
  return created.task;
}

/** For the browser walkthrough: one unconfirmed demo task waiting for the student. */
export async function ensureDraftDemoTask(api) {
  const { tasks } = await api.get("student", `/api/research-tasks?studentId=${encodeURIComponent(STUDENT_ID)}`);
  const draft = tasks.find((task) => String(task.title ?? "").startsWith(TASK_TITLE_PREFIX) && task.status === "draft");
  return draft ? { task: draft, created: false } : { task: await createDemoTask(api), created: true };
}

async function waitFor(label, read, done, { timeoutMs = 180_000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await read();
    if (done(last)) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/**
 * Runs the whole loop and checks each hand-off. Returns a summary (ids, PR
 * number, metrics); throws with the failing step otherwise.
 */
export async function runAutoFlow(api, { entrypoint, datasetVersion, fakeGithub, log }) {
  const step = (text) => log(`  ✔ ${text}`);

  const task = await createDemoTask(api);
  step(`学生创建任务 ${task.id}（草稿）`);
  await api.post("student", "/api/research-tasks", { action: "confirm", taskId: task.id, version: task.version ?? 1 });
  step("学生确认任务");

  const { attempt } = await api.post("student", "/api/agent-attempts", { action: "start", taskId: task.id, provider: "codex", idempotencyKey: key("attempt") });
  step(`学生启动代理尝试 ${attempt.id}（base ${String(attempt.baseCommitSha).slice(0, 12)}，来自本地 GitHub 替身）`);
  const detail = await waitFor("agent attempt result", () => api.get("student", `/api/agent-attempts?attemptId=${attempt.id}`),
    (value) => ["change_ready", "failed", "canceled"].includes(value.attempt.status), { timeoutMs: 120_000 });
  if (detail.attempt.status !== "change_ready") throw new Error(`agent attempt ended ${detail.attempt.status}: ${detail.attempt.errorCode ?? ""} ${detail.attempt.errorMessage ?? ""}`);
  step(`代理工作进程改动 ${detail.attempt.changedPaths.join(", ")}，测试 ${detail.attempt.tests.map((test) => `${test.command} → ${test.exitCode}`).join("; ")}`);

  const crId = detail.changeRequest.id;
  const cr = (await api.get("student", `/api/change-requests?changeRequestId=${crId}`)).changeRequest;
  if (cr.requiresExtraReview) throw new Error("demo change unexpectedly requires extra review");
  const published = (await api.post("student", "/api/change-requests", { action: "publish", changeRequestId: crId, expectedVersion: cr.version })).changeRequest;
  if (published.status !== "open" || !(published.prNumber >= FIRST_PR_NUMBER)) throw new Error(`publish returned ${published.status} PR ${published.prNumber}`);
  step(`学生发布 PR #${published.prNumber}（分支 ${published.branchName}，head ${String(published.headCommitSha).slice(0, 12)}）→ ${fakeGithub.url}/${published.prUrl.replace("https://github.com/", "")}`);

  const run = await api.post("student", "/api/runs", {
    action: "create", taskId: task.id, changeRequestId: crId, entrypointId: entrypoint.id, params: { epochs: 3, seed: 7 },
    datasetVersionId: datasetVersion.id, resources: { gpuCount: 0, walltimeMinutes: 10, memoryGb: 4 }, idempotencyKey: key("run"),
  });
  step(`学生登记运行 ${run.runId}（待导师批准）`);
  const pending = await api.get("mentor", `/api/runs?runId=${run.runId}`);
  if (pending.spec.executedCommitSha !== published.headCommitSha) throw new Error("run spec does not execute the PR head");
  await api.post("mentor", "/api/runs", { action: "approve", runId: run.runId, runSpecSha256: pending.run.runSpecSha256 });
  step(`导师核对规范哈希 ${pending.run.runSpecSha256.slice(0, 12)}… 并批准`);

  const finished = await waitFor("lab run", () => api.get("mentor", `/api/runs?runId=${run.runId}`),
    (value) => ["completed", "failed", "canceled"].includes(value.run.status), { timeoutMs: 240_000 });
  if (finished.run.status !== "completed") throw new Error(`run ended ${finished.run.status}: ${finished.run.failureReason ?? ""}`);
  const result = finished.result;
  if (result?.technicalValidity !== "valid") throw new Error(`result is ${result?.technicalValidity}: ${result?.validityNotes ?? ""}`);
  const outputs = finished.artifacts.filter((item) => item.egressDecision === "published").map((item) => item.relativePath);
  const held = finished.artifacts.filter((item) => item.egressDecision === "held").map((item) => item.relativePath);
  // R03 default: only a validated metrics.json leaves the lab. The demo dataset
  // registers no autoPublishPaths, so predictions and logs stay held.
  if (outputs.join(",") !== "metrics.json") throw new Error(`expected only metrics.json to be published, got ${outputs.join(", ") || "(none)"}`);
  step(`实验室执行器完成（退出码 ${finished.run.exitCode}），结果有效，指标 ${JSON.stringify(result.metrics.values)}；外发产物 ${outputs.join(", ")}`);
  if (held.length) {
    step(`扣留在实验室 ${held.join(", ")}：外发默认扣留，只自动外发校验通过的 metrics.json；其余产物需数据持有方在数据集外发策略中登记 autoPublishPaths 后才会外发`);
  }

  const reviewed = await api.post("mentor", "/api/run-results", {
    action: "review", runId: run.runId, expectedVersion: finished.review?.version ?? 1, state: "accepted", hypothesisOutcome: "supported",
    note: "（演示）accuracy = 1.0，假设成立。",
  });
  step(`导师评审：${reviewed.state}`);
  return { taskId: task.id, attemptId: attempt.id, changeRequestId: crId, prNumber: published.prNumber, runId: run.runId, metrics: result.metrics.values };
}
