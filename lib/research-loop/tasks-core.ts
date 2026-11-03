import {
  DEFAULT_PROTECTED_PATHS, LIMITS, newId, taskSnapshotSha256,
  type ResearchTaskSnapshot, type TaskBudget,
} from "./contracts.ts";

export class TaskInputError extends Error {}

export type TaskContent = {
  title: string;
  researchQuestion: string;
  hypothesis: string;
  instructions: string;
  acceptanceCriteria: string;
  allowedPaths: string[];
  protectedPaths: string[];
  budget: TaskBudget;
};

const PATTERN = /^[A-Za-z0-9._\-/*?@+]{1,200}$/;

function text(value: unknown, label: string, max: number, required = true) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new TaskInputError(`${label}格式无效`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new TaskInputError(`请填写${label}`);
  if ([...trimmed].length > max) throw new TaskInputError(`${label}不能超过 ${max} 个字符`);
  return trimmed;
}

function patterns(value: unknown, label: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw new TaskInputError(`${label}需为不超过 50 项的列表`);
  return [...new Set(value.map((item) => {
    if (typeof item !== "string" || !PATTERN.test(item) || item.startsWith("/") || item.split("/").includes("..")) {
      throw new TaskInputError(`${label}包含无效路径模式`);
    }
    return item;
  }))].sort();
}

function bounded(value: unknown, label: string, max: number) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new TaskInputError(`${label}需为 0–${max} 的整数`);
  }
  return value;
}

/** Validates task content from a request body. Protected paths always include
 * the defaults; callers may add more but never remove them. */
export function parseTaskContent(body: Record<string, unknown>): TaskContent {
  const budgetInput = body.budget && typeof body.budget === "object" && !Array.isArray(body.budget)
    ? body.budget as Record<string, unknown> : {};
  const budget: TaskBudget = {};
  const maxAgentMinutes = bounded(budgetInput.maxAgentMinutes, "代理时长上限", 240);
  const maxGpuCount = bounded(budgetInput.maxGpuCount, "GPU 数量上限", 8);
  const maxWalltimeMinutes = bounded(budgetInput.maxWalltimeMinutes, "运行时长上限", 7 * 24 * 60);
  if (maxAgentMinutes !== undefined) budget.maxAgentMinutes = maxAgentMinutes;
  if (maxGpuCount !== undefined) budget.maxGpuCount = maxGpuCount;
  if (maxWalltimeMinutes !== undefined) budget.maxWalltimeMinutes = maxWalltimeMinutes;
  return {
    title: text(body.title, "任务标题", 120),
    researchQuestion: text(body.researchQuestion, "研究问题", 2000),
    hypothesis: text(body.hypothesis, "假设", 2000, false),
    instructions: text(body.instructions, "执行说明", LIMITS.maxInstructionChars),
    acceptanceCriteria: text(body.acceptanceCriteria, "验收标准", 4000),
    allowedPaths: patterns(body.allowedPaths, "允许修改路径"),
    protectedPaths: [...new Set([...DEFAULT_PROTECTED_PATHS, ...patterns(body.protectedPaths, "受保护路径")])].sort(),
    budget,
  };
}

export function buildTaskSnapshot(input: { taskId: string; version: number; studentId: string; content: TaskContent }): ResearchTaskSnapshot {
  const { content } = input;
  return {
    schema: "tanyan.task/v1",
    taskId: input.taskId,
    version: input.version,
    studentId: input.studentId,
    title: content.title,
    researchQuestion: content.researchQuestion,
    hypothesis: content.hypothesis,
    instructions: content.instructions,
    acceptanceCriteria: content.acceptanceCriteria,
    allowedPaths: content.allowedPaths,
    protectedPaths: content.protectedPaths,
    budget: content.budget,
  };
}

/** Creates a draft task (version 1) with its version row and audit event in
 * one batch. Idempotent on mutationId: a replay returns the existing task.
 * Authorization is the caller's responsibility. */
export async function createResearchTask(d1: D1Database, input: {
  studentId: string;
  authorUserId: number;
  mutationId: string;
  content: TaskContent;
  sourceGuidanceNoteId?: number | null;
  sourceRunId?: string | null;
  parentTaskId?: string | null;
}) {
  const existing = await d1.prepare("SELECT id, current_version FROM research_tasks WHERE create_mutation_id = ?")
    .bind(input.mutationId).first<{ id: string; current_version: number }>();
  if (existing) return { taskId: existing.id, version: existing.current_version, replayed: true };
  const taskId = newId("task");
  const snapshot = buildTaskSnapshot({ taskId, version: 1, studentId: input.studentId, content: input.content });
  const snapshotSha256 = await taskSnapshotSha256(snapshot);
  const { content } = input;
  await d1.batch([
    d1.prepare(`INSERT INTO research_tasks
      (id, student_id, source_guidance_note_id, source_run_id, parent_task_id, title, status, current_version,
       created_by_user_id, create_mutation_id, last_mutation_id)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)`)
      .bind(taskId, input.studentId, input.sourceGuidanceNoteId ?? null, input.sourceRunId ?? null,
        input.parentTaskId ?? null, content.title, input.authorUserId, input.mutationId, input.mutationId),
    d1.prepare(`INSERT INTO research_task_versions
      (task_id, version, title, research_question, hypothesis, instructions, acceptance_criteria,
       allowed_paths_json, protected_paths_json, budget_json, snapshot_sha256, author_user_id)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(taskId, content.title, content.researchQuestion, content.hypothesis, content.instructions, content.acceptanceCriteria,
        JSON.stringify(content.allowedPaths), JSON.stringify(content.protectedPaths), JSON.stringify(content.budget),
        snapshotSha256, input.authorUserId),
    d1.prepare(`INSERT INTO research_task_events (task_id, version, action, actor_type, actor_user_id, payload_json)
      VALUES (?, 1, 'created', 'user', ?, ?)`)
      .bind(taskId, input.authorUserId, JSON.stringify({ snapshotSha256, sourceRunId: input.sourceRunId ?? null, parentTaskId: input.parentTaskId ?? null })),
  ]);
  return { taskId, version: 1, replayed: false };
}
