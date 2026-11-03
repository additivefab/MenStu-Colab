// Run registry (docs/科研闭环_实施规格_v1.md §6.3): admin lab registry, run
// creation/approval/cancel/rerun, and the compute-runner lab protocol.
// Every status change goes through `transitionStatements`: the transition is
// checked against RUN_TRANSITIONS, a run_events row is written in the same
// batch, and every statement is guarded by the expected status + lease epoch
// so a concurrent writer turns the whole batch into a no-op (409).
import { env } from "cloudflare:workers";
import { canReviewStudent, canViewStudent } from "./authorization";
import type { AppUser } from "./feishu-auth";
import { GithubNotConfiguredError, mintRepositoryReadToken } from "./github/tokens.ts";
import { GithubCommitNotFoundError, resolveCommitSha } from "./github/repository-read.ts";
import { issueRunnerToken, type LabRunner } from "./lab-runner-auth.ts";
import {
  ARTIFACT_KINDS, EGRESS_DECISIONS, EGRESS_IMAGE_EXTENSIONS, LIMITS, RUN_TRANSITIONS, TERMINAL_RUN_STATUSES,
  canTransition, canonicalJson, isCommitSha, isSha256, newId, normalizeRepoPath, runSpecSha256, sha256Hex,
  validateMetricsFile,
  type ArtifactKind, type ComputeClaimResponse, type ComputeReconcileResponse, type EgressDecision, type EgressPolicy, type JsonValue,
  type ManifestArtifact, type RunManifest, type RunSpec, type RunStatus,
} from "./research-loop/contracts.ts";

// ---------------------------------------------------------------------------
// Errors and small validators
// ---------------------------------------------------------------------------

export class RunServiceError extends Error {
  status: 400 | 403 | 404 | 409 | 413 | 422 | 503;
  code: string;
  constructor(status: RunServiceError["status"], message: string, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (message: string, code = "INVALID_INPUT") => new RunServiceError(400, message, code);
const forbidden = (message: string) => new RunServiceError(403, message, "FORBIDDEN");
const notFound = (message: string) => new RunServiceError(404, message, "NOT_FOUND");
const conflict = (message: string, code = "CONFLICT") => new RunServiceError(409, message, code);
const leaseLost = () => new RunServiceError(409, "租约已失效，请停止处理该运行", "LEASE_LOST");

const CONTROL = { test: (value: string) => [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) };
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

function text(value: unknown, label: string, max: number, required = true) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw bad(`${label}格式无效`);
  const trimmed = value.trim();
  if (required && !trimmed) throw bad(`请填写${label}`);
  if ([...trimmed].length > max) throw bad(`${label}不能超过 ${max} 个字符`);
  return trimmed;
}

function identifier(value: unknown, label: string) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw bad(`${label}无效`);
  return value;
}

export function idempotencyKey(value: unknown, label = "幂等键") {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) throw bad(`${label}无效`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw bad(`${label}需为 ${min}–${max} 的整数`);
  }
  return value;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad(`${label}格式无效`);
  return value as Record<string, unknown>;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function nowIso() {
  return new Date().toISOString();
}

function leaseExpiry(from = Date.now()) {
  return new Date(from + LIMITS.leaseSeconds * 1000).toISOString();
}

export function getRunArtifactBucket() {
  if (!env.FILES) throw new RunServiceError(503, "产物存储尚未配置", "STORAGE_UNAVAILABLE");
  return env.FILES;
}

export const artifactR2Key = (runId: string, relativePath: string) => `runs/${runId}/${relativePath}`;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type RunRow = {
  id: string;
  run_spec_sha256: string;
  attempt: number;
  approval_id: string | null;
  task_id: string;
  student_id: string;
  status: RunStatus;
  idempotency_key: string;
  submit_tag: string;
  runner_id: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  scheduler_job_id: string | null;
  exit_code: number | null;
  failure_reason: string;
  cancel_requested_at: string | null;
  cancel_requested_by_user_id: number | null;
  created_by_user_id: number;
  created_at: string;
  queued_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
};

export async function loadRun(d1: D1Database, runId: string) {
  return d1.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<RunRow>();
}

export async function loadSpec(d1: D1Database, sha256: string) {
  const row = await d1.prepare("SELECT canonical_json, created_by_user_id FROM run_specs WHERE sha256 = ?")
    .bind(sha256).first<{ canonical_json: string; created_by_user_id: number }>();
  if (!row) throw new RunServiceError(503, "运行规范缺失", "SPEC_MISSING");
  const spec = JSON.parse(row.canonical_json) as RunSpec;
  // Integrity: the stored canonical JSON must still hash to its primary key.
  if (await runSpecSha256(spec) !== sha256) throw new RunServiceError(503, "运行规范校验失败", "SPEC_CORRUPT");
  return { spec, createdByUserId: row.created_by_user_id };
}

const isTerminal = (status: RunStatus) => TERMINAL_RUN_STATUSES.includes(status);

// ---------------------------------------------------------------------------
// Guarded transitions
// ---------------------------------------------------------------------------

type Actor = { type: "user" | "runner" | "system"; id: string };
type SetValue = string | number | null | { raw: string };

const SETTABLE = new Set([
  "approval_id", "runner_id", "lease_epoch", "lease_expires_at", "heartbeat_at", "scheduler_job_id",
  "exit_code", "failure_reason", "cancel_requested_at", "cancel_requested_by_user_id", "queued_at",
  "started_at", "ended_at",
]);

/** SQL guard + binds that hold only while the run is still in the state we read. */
export function runGuard(run: Pick<RunRow, "id" | "status" | "lease_epoch">) {
  return {
    sql: "EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = ? AND lease_epoch = ?)",
    binds: [run.id, run.status, run.lease_epoch] as unknown[],
  };
}

/** Events for each step of `path` (all guarded on the starting state) followed
 * by the guarded UPDATE, which must stay the LAST statement of the batch.
 * An empty path writes no status change; `auditTo` records a same-status
 * audit event (e.g. a cancel flag set while collecting). */
export function transitionStatements(d1: D1Database, run: RunRow, input: {
  path: RunStatus[];
  actor: Actor;
  payload?: Record<string, JsonValue>;
  set?: Record<string, SetValue>;
  audit?: boolean;
}) {
  let from = run.status;
  for (const to of input.path) {
    if (!canTransition(RUN_TRANSITIONS, from, to)) throw conflict(`运行状态不允许从 ${from} 变为 ${to}`, "INVALID_TRANSITION");
    from = to;
  }
  const guard = runGuard(run);
  const statements: D1PreparedStatement[] = [];
  const steps: [RunStatus, RunStatus][] = [];
  let previous = run.status;
  for (const to of input.path) { steps.push([previous, to]); previous = to; }
  if (!steps.length && input.audit) steps.push([run.status, run.status]);
  // Batch statements run sequentially in one transaction, so each insert sees
  // the previous one and MAX + 1 stays strictly monotonic.
  for (const [stepFrom, stepTo] of steps) {
    statements.push(d1.prepare(`INSERT INTO run_events (run_id, sequence, from_status, to_status, actor_type, actor_id, payload_json)
      SELECT ?, COALESCE((SELECT MAX(sequence) FROM run_events WHERE run_id = ?), 0) + 1, ?, ?, ?, ?, ?
      WHERE ${guard.sql}`)
      .bind(run.id, run.id, stepFrom, stepTo, input.actor.type, input.actor.id,
        JSON.stringify(input.payload ?? {}), ...guard.binds));
  }
  const assignments = ["updated_at = CURRENT_TIMESTAMP"];
  const binds: unknown[] = [];
  if (input.path.length) { assignments.push("status = ?"); binds.push(previous); }
  for (const [column, value] of Object.entries(input.set ?? {})) {
    if (!SETTABLE.has(column)) throw new Error(`unsupported run column ${column}`);
    if (value && typeof value === "object") assignments.push(`${column} = ${value.raw}`);
    else { assignments.push(`${column} = ?`); binds.push(value); }
  }
  statements.push(d1.prepare(`UPDATE runs SET ${assignments.join(", ")} WHERE id = ? AND status = ? AND lease_epoch = ?`)
    .bind(...binds, ...guard.binds));
  return statements;
}

/** Runs the batch and reports whether the guarded UPDATE (last statement) applied. */
export async function commitGuarded(d1: D1Database, statements: D1PreparedStatement[]) {
  const results = await d1.batch(statements);
  return (results[results.length - 1]?.meta?.changes ?? 0) === 1;
}

const STALE = () => conflict("运行状态已变化，请刷新后重试", "STALE_STATE");

// ---------------------------------------------------------------------------
// Admin lab registry (superadmin only; callers check the role)
// ---------------------------------------------------------------------------

export type ParamSpec = {
  type: "string" | "integer" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  enum?: (string | number | boolean)[];
  maxLength?: number;
};
export type ParamsSchema = { [name: string]: ParamSpec };

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const IMAGE_REF = /^[a-z0-9][a-z0-9._\-/:]{0,200}@sha256:[0-9a-f]{64}$/;
const EXTENSION = /^\.[a-z0-9]{1,10}$/;

function checkParamValue(name: string, spec: ParamSpec, value: unknown): string | number | boolean {
  switch (spec.type) {
    case "boolean":
      if (typeof value !== "boolean") throw bad(`参数 ${name} 需为布尔值`);
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) throw bad(`参数 ${name} 需为整数`);
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad(`参数 ${name} 需为数字`);
      break;
    case "string":
      if (typeof value !== "string" || CONTROL.test(value) || [...value].length > (spec.maxLength ?? 200)) {
        throw bad(`参数 ${name} 需为不超过 ${spec.maxLength ?? 200} 个字符的文本`);
      }
      break;
  }
  if (typeof value === "number") {
    if (spec.minimum !== undefined && value < spec.minimum) throw bad(`参数 ${name} 不能小于 ${spec.minimum}`);
    if (spec.maximum !== undefined && value > spec.maximum) throw bad(`参数 ${name} 不能大于 ${spec.maximum}`);
  }
  if (spec.enum && !spec.enum.includes(value as string | number | boolean)) throw bad(`参数 ${name} 不在允许值内`);
  return value as string | number | boolean;
}

export function parseParamsSchema(value: unknown): ParamsSchema {
  const input = value === undefined || value === null ? {} : plainObject(value, "参数定义");
  const entries = Object.entries(input);
  if (entries.length > 50) throw bad("参数定义最多 50 项");
  const schema: ParamsSchema = {};
  for (const [name, raw] of entries) {
    if (!PARAM_NAME.test(name)) throw bad(`参数名无效：${name}`);
    const item = plainObject(raw, `参数 ${name} 的定义`);
    const allowedKeys = new Set(["type", "required", "default", "minimum", "maximum", "enum", "maxLength"]);
    if (Object.keys(item).some((key) => !allowedKeys.has(key))) throw bad(`参数 ${name} 的定义包含未知字段`);
    if (!["string", "integer", "number", "boolean"].includes(item.type as string)) throw bad(`参数 ${name} 的类型无效`);
    const spec: ParamSpec = { type: item.type as ParamSpec["type"] };
    if (item.required !== undefined) {
      if (typeof item.required !== "boolean") throw bad(`参数 ${name} 的 required 无效`);
      spec.required = item.required;
    }
    for (const key of ["minimum", "maximum"] as const) {
      if (item[key] !== undefined) {
        if (typeof item[key] !== "number" || !Number.isFinite(item[key])) throw bad(`参数 ${name} 的 ${key} 无效`);
        spec[key] = item[key] as number;
      }
    }
    if (item.maxLength !== undefined) spec.maxLength = integer(item.maxLength, `参数 ${name} 的 maxLength`, 1, 200);
    if (item.enum !== undefined) {
      if (!Array.isArray(item.enum) || !item.enum.length || item.enum.length > 50) throw bad(`参数 ${name} 的 enum 无效`);
      spec.enum = item.enum.map((option) => checkParamValue(name, { type: spec.type, maxLength: spec.maxLength }, option));
    }
    if (item.default !== undefined) spec.default = checkParamValue(name, spec, item.default);
    schema[name] = spec;
  }
  return schema;
}

export function validateParams(schema: ParamsSchema, value: unknown) {
  const input = value === undefined || value === null ? {} : plainObject(value, "运行参数");
  const unknown = Object.keys(input).filter((key) => !Object.prototype.hasOwnProperty.call(schema, key));
  if (unknown.length) throw bad(`入口未定义参数：${unknown.join("、")}`);
  const params: { [key: string]: string | number | boolean } = {};
  for (const [name, spec] of Object.entries(schema)) {
    if (input[name] === undefined || input[name] === null) {
      if (spec.default !== undefined) params[name] = spec.default;
      else if (spec.required) throw bad(`缺少必填参数：${name}`);
      continue;
    }
    params[name] = checkParamValue(name, spec, input[name]);
  }
  return params;
}

function parseArgv(value: unknown) {
  if (!Array.isArray(value)) throw bad("argv 必须是字符串数组，不接受 shell 命令行");
  if (!value.length || value.length > 64) throw bad("argv 需为 1–64 项");
  return value.map((item, index) => {
    if (typeof item !== "string" || !item || item.length > 512 || CONTROL.test(item)) throw bad(`argv 第 ${index + 1} 项无效`);
    if (index === 0 && (/\s/u.test(item) || /[;&|`$<>(){}*?!~]/u.test(item))) throw bad("argv 第 1 项必须是单个可执行文件，不能包含空格或 shell 符号");
    return item;
  });
}

export function parseEgressPolicy(value: unknown): EgressPolicy {
  const input = plainObject(value, "外发策略");
  if (input.schema !== "tanyan.egress/v1") throw bad("外发策略 schema 必须为 tanyan.egress/v1");
  const allowedKeys = new Set(["schema", "allowedExtensions", "maxFileBytes", "maxTotalBytes", "allowImages", "blockDatasetHashMatches"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw bad("外发策略包含未知字段");
  if (!Array.isArray(input.allowedExtensions) || input.allowedExtensions.length > 50) throw bad("扩展名白名单需为不超过 50 项的列表");
  const allowedExtensions = [...new Set(input.allowedExtensions.map((item) => {
    if (typeof item !== "string" || !EXTENSION.test(item)) throw bad("扩展名需为小写、以点开头，例如 .json");
    return item;
  }))].sort();
  const maxFileBytes = integer(input.maxFileBytes, "单文件上限", 1, LIMITS.maxPublishedArtifactBytes);
  const maxTotalBytes = integer(input.maxTotalBytes, "总量上限", 1, 100 * LIMITS.maxPublishedArtifactBytes);
  if (typeof input.allowImages !== "boolean") throw bad("allowImages 需为布尔值");
  if (input.blockDatasetHashMatches !== true) throw bad("blockDatasetHashMatches 必须为 true");
  return { schema: "tanyan.egress/v1", allowedExtensions, maxFileBytes, maxTotalBytes, allowImages: input.allowImages, blockDatasetHashMatches: true };
}

async function activeLink(d1: D1Database, studentId: string) {
  return d1.prepare(`SELECT student_id, github_repository_id, installation_id, full_name, default_branch
    FROM repository_links WHERE student_id = ? AND status = 'active'`)
    .bind(studentId)
    .first<{ student_id: string; github_repository_id: number; installation_id: number; full_name: string; default_branch: string }>();
}

export async function readLabRegistry(d1: D1Database) {
  const [runners, entrypoints, datasets, grants] = await Promise.all([
    d1.prepare("SELECT id, label, kind, status, last_seen_at, created_at FROM lab_runners ORDER BY created_at, id").all<Record<string, unknown>>(),
    d1.prepare(`SELECT e.*, (SELECT l.student_id FROM repository_links l WHERE l.github_repository_id = e.github_repository_id ORDER BY l.status = 'active' DESC LIMIT 1) AS student_id
      FROM registered_entrypoints e ORDER BY e.created_at, e.id`).all<Record<string, unknown>>(),
    d1.prepare("SELECT * FROM dataset_versions ORDER BY created_at, id").all<Record<string, unknown>>(),
    d1.prepare("SELECT * FROM dataset_grants ORDER BY dataset_version_id, student_id").all<Record<string, unknown>>(),
  ]);
  return {
    runners: runners.results.map((row) => ({
      id: row.id, label: row.label, kind: row.kind, status: row.status, lastSeenAt: row.last_seen_at, createdAt: row.created_at,
    })),
    entrypoints: entrypoints.results.map(entrypointView),
    datasets: datasets.results.map(datasetView),
    grants: grants.results.map((row) => ({
      datasetVersionId: row.dataset_version_id, studentId: row.student_id, grantedAt: row.granted_at,
      grantedByUserId: row.granted_by_user_id, revokedAt: row.revoked_at, active: row.revoked_at === null,
    })),
  };
}

export function entrypointView(row: Record<string, unknown>) {
  return {
    id: row.id, studentId: row.student_id ?? null, githubRepositoryId: row.github_repository_id, name: row.name,
    argv: parseJson<string[]>(row.argv_json as string, []), paramsSchema: parseJson<ParamsSchema>(row.params_schema_json as string, {}),
    imageRef: row.image_ref, evaluationProtocolSha256: row.evaluation_protocol_sha256, active: row.active === 1, createdAt: row.created_at,
  };
}

export function datasetView(row: Record<string, unknown>) {
  return {
    id: row.id, label: row.label, runnerId: row.runner_id, manifestSha256: row.manifest_sha256,
    splitManifestSha256: row.split_manifest_sha256, egressPolicy: parseJson<EgressPolicy | null>(row.egress_policy_json as string, null),
    active: row.active === 1, createdAt: row.created_at,
  };
}

export async function applyLabAdminAction(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  switch (body.action) {
    case "register_runner": {
      const label = text(body.label, "执行器名称", 80);
      if (body.kind !== "compute" && body.kind !== "agent") throw bad("执行器类型需为 compute 或 agent");
      const id = newId("rnr");
      const { token, tokenSha256 } = await issueRunnerToken();
      await d1.prepare("INSERT INTO lab_runners (id, label, kind, token_sha256, created_by_user_id) VALUES (?, ?, ?, ?, ?)")
        .bind(id, label, body.kind, tokenSha256, actor.id).run();
      // The plaintext token is returned exactly once; only its hash is stored.
      return { runner: { id, label, kind: body.kind, status: "active" }, token };
    }
    case "disable_runner": {
      const runnerId = identifier(body.runnerId, "执行器");
      const result = await d1.prepare("UPDATE lab_runners SET status = 'disabled' WHERE id = ?").bind(runnerId).run();
      if (!result.meta.changes) throw notFound("执行器不存在");
      return { runnerId, status: "disabled" };
    }
    case "register_entrypoint": {
      const studentId = identifier(body.studentId, "学生");
      const link = await activeLink(d1, studentId);
      if (!link) throw conflict("该学生尚未关联已验证的 GitHub 仓库", "REPOSITORY_NOT_LINKED");
      const name = text(body.name, "入口名称", 80);
      const argv = parseArgv(body.argv);
      const paramsSchema = parseParamsSchema(body.paramsSchema);
      if (typeof body.imageRef !== "string" || !IMAGE_REF.test(body.imageRef)) throw bad("镜像引用必须带 @sha256:<64 位十六进制> 摘要");
      if (!isSha256(body.evaluationProtocolSha256)) throw bad("评价协议 sha256 无效");
      const id = newId("ep");
      await d1.prepare(`INSERT INTO registered_entrypoints
        (id, github_repository_id, name, argv_json, params_schema_json, image_ref, evaluation_protocol_sha256, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, link.github_repository_id, name, JSON.stringify(argv), canonicalJson(paramsSchema as unknown as JsonValue),
          body.imageRef, body.evaluationProtocolSha256, actor.id).run();
      return { entrypoint: { id, studentId, githubRepositoryId: link.github_repository_id, name, argv, paramsSchema, imageRef: body.imageRef, evaluationProtocolSha256: body.evaluationProtocolSha256, active: true } };
    }
    case "disable_entrypoint": {
      const entrypointId = identifier(body.entrypointId, "入口");
      const result = await d1.prepare("UPDATE registered_entrypoints SET active = 0 WHERE id = ?").bind(entrypointId).run();
      if (!result.meta.changes) throw notFound("入口不存在");
      return { entrypointId, active: false };
    }
    case "register_dataset": {
      const label = text(body.label, "数据集名称", 120);
      const runnerId = identifier(body.runnerId, "执行器");
      const runner = await d1.prepare("SELECT kind, status FROM lab_runners WHERE id = ?").bind(runnerId).first<{ kind: string; status: string }>();
      if (!runner || runner.kind !== "compute" || runner.status !== "active") throw bad("数据集只能托管在有效的计算执行器上");
      if (!isSha256(body.manifestSha256)) throw bad("数据清单 sha256 无效");
      const split = body.splitManifestSha256 ?? "";
      if (split !== "" && !isSha256(split)) throw bad("划分清单 sha256 无效");
      const egressPolicy = parseEgressPolicy(body.egressPolicy);
      const id = newId("ds");
      await d1.prepare(`INSERT INTO dataset_versions (id, label, runner_id, manifest_sha256, split_manifest_sha256, egress_policy_json, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, label, runnerId, body.manifestSha256, split, canonicalJson(egressPolicy as unknown as JsonValue), actor.id).run();
      return { dataset: { id, label, runnerId, manifestSha256: body.manifestSha256, splitManifestSha256: split, egressPolicy, active: true } };
    }
    case "disable_dataset": {
      const datasetVersionId = identifier(body.datasetVersionId, "数据集版本");
      const result = await d1.prepare("UPDATE dataset_versions SET active = 0 WHERE id = ?").bind(datasetVersionId).run();
      if (!result.meta.changes) throw notFound("数据集版本不存在");
      return { datasetVersionId, active: false };
    }
    case "grant_dataset":
    case "revoke_dataset": {
      const datasetVersionId = identifier(body.datasetVersionId, "数据集版本");
      const studentId = identifier(body.studentId, "学生");
      const dataset = await d1.prepare("SELECT id FROM dataset_versions WHERE id = ?").bind(datasetVersionId).first();
      if (!dataset) throw notFound("数据集版本不存在");
      const student = await d1.prepare("SELECT id FROM students WHERE id = ?").bind(studentId).first();
      if (!student) throw notFound("学生不存在");
      if (body.action === "grant_dataset") {
        // Compute permission only: the job may mount the data read-only.
        await d1.prepare(`INSERT INTO dataset_grants (dataset_version_id, student_id, granted_by_user_id) VALUES (?, ?, ?)
          ON CONFLICT (dataset_version_id, student_id) DO UPDATE SET
            granted_by_user_id = excluded.granted_by_user_id, granted_at = CURRENT_TIMESTAMP, revoked_at = NULL, revoked_by_user_id = NULL`)
          .bind(datasetVersionId, studentId, actor.id).run();
        return { datasetVersionId, studentId, active: true };
      }
      const result = await d1.prepare(`UPDATE dataset_grants SET revoked_at = CURRENT_TIMESTAMP, revoked_by_user_id = ?
        WHERE dataset_version_id = ? AND student_id = ? AND revoked_at IS NULL`)
        .bind(actor.id, datasetVersionId, studentId).run();
      if (!result.meta.changes) throw notFound("没有有效的数据授权");
      return { datasetVersionId, studentId, active: false };
    }
    default:
      throw bad("未知操作");
  }
}

// ---------------------------------------------------------------------------
// Run creation, approval, cancel, rerun
// ---------------------------------------------------------------------------

type TaskRow = { id: string; student_id: string; status: string; confirmed_version: number | null };

async function confirmedTask(d1: D1Database, taskId: string) {
  const task = await d1.prepare("SELECT id, student_id, status, confirmed_version FROM research_tasks WHERE id = ?")
    .bind(taskId).first<TaskRow>();
  if (!task) throw notFound("研究任务不存在");
  return task;
}

function parseResources(value: unknown) {
  const input = plainObject(value, "资源");
  return {
    gpuCount: integer(input.gpuCount, "GPU 数量", 0, 8),
    walltimeMinutes: integer(input.walltimeMinutes, "运行时长（分钟）", 1, 7 * 24 * 60),
    memoryGb: integer(input.memoryGb, "内存（GB）", 1, 2048),
  };
}

async function assertActiveStudent(d1: D1Database, studentId: string) {
  const student = await d1.prepare("SELECT active FROM students WHERE id = ?").bind(studentId).first<{ active: number }>();
  if (!student || student.active !== 1) throw notFound("学生不存在或已停用");
}

export async function createRun(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  const key = idempotencyKey(body.idempotencyKey);
  const taskId = identifier(body.taskId, "研究任务");
  const replay = await d1.prepare("SELECT * FROM runs WHERE idempotency_key = ?").bind(key).first<RunRow>();
  if (replay) {
    if (replay.task_id !== taskId || replay.created_by_user_id !== actor.id) throw conflict("幂等键已用于其他运行", "IDEMPOTENCY_CONFLICT");
    return { runId: replay.id, runSpecSha256: replay.run_spec_sha256, attempt: replay.attempt, status: replay.status, replayed: true };
  }

  const task = await confirmedTask(d1, taskId);
  if (!(await canViewStudent(actor, task.student_id))) throw forbidden("无权为该学生创建运行");
  await assertActiveStudent(d1, task.student_id);
  if (task.status !== "confirmed" || !task.confirmed_version) throw conflict("研究任务尚未确认", "TASK_NOT_CONFIRMED");
  const version = await d1.prepare("SELECT snapshot_sha256, budget_json FROM research_task_versions WHERE task_id = ? AND version = ?")
    .bind(task.id, task.confirmed_version).first<{ snapshot_sha256: string; budget_json: string }>();
  if (!version) throw conflict("研究任务确认版本缺失", "TASK_NOT_CONFIRMED");

  const link = await activeLink(d1, task.student_id);
  if (!link) throw conflict("该学生尚未关联已验证的 GitHub 仓库", "REPOSITORY_NOT_LINKED");

  const entrypointId = identifier(body.entrypointId, "入口");
  const entrypoint = await d1.prepare("SELECT * FROM registered_entrypoints WHERE id = ? AND active = 1")
    .bind(entrypointId).first<Record<string, unknown>>();
  if (!entrypoint) throw notFound("入口不存在或已停用");
  if (entrypoint.github_repository_id !== link.github_repository_id) throw forbidden("入口不属于该学生的仓库");
  const datasetVersionId = identifier(body.datasetVersionId, "数据集版本");
  const dataset = await d1.prepare("SELECT * FROM dataset_versions WHERE id = ? AND active = 1")
    .bind(datasetVersionId).first<Record<string, unknown>>();
  if (!dataset) throw notFound("数据集版本不存在或已停用");
  const grant = await d1.prepare("SELECT 1 AS ok FROM dataset_grants WHERE dataset_version_id = ? AND student_id = ? AND revoked_at IS NULL")
    .bind(datasetVersionId, task.student_id).first();
  if (!grant) throw forbidden("该学生没有此数据集的有效计算授权");

  const params = validateParams(parseJson<ParamsSchema>(entrypoint.params_schema_json as string, {}), body.params);
  const resources = parseResources(body.resources);
  const budget = parseJson<{ maxGpuCount?: number; maxWalltimeMinutes?: number }>(version.budget_json, {});
  if (budget.maxGpuCount !== undefined && resources.gpuCount > budget.maxGpuCount) {
    throw bad(`GPU 数量超过任务预算（上限 ${budget.maxGpuCount}）`, "OVER_BUDGET");
  }
  if (budget.maxWalltimeMinutes !== undefined && resources.walltimeMinutes > budget.maxWalltimeMinutes) {
    throw bad(`运行时长超过任务预算（上限 ${budget.maxWalltimeMinutes} 分钟）`, "OVER_BUDGET");
  }

  const hasCr = body.changeRequestId !== undefined && body.changeRequestId !== null && body.changeRequestId !== "";
  const hasSha = body.executedCommitSha !== undefined && body.executedCommitSha !== null && body.executedCommitSha !== "";
  if (hasCr === hasSha) throw bad("请在变更请求和提交 SHA 中二选一");
  let executedCommitSha: string;
  let changeRequestId: string | null = null;
  if (hasCr) {
    changeRequestId = identifier(body.changeRequestId, "变更请求");
    const cr = await d1.prepare("SELECT task_id, student_id, github_repository_id, head_commit_sha, status FROM change_requests WHERE id = ?")
      .bind(changeRequestId).first<{ task_id: string; student_id: string; github_repository_id: number; head_commit_sha: string | null; status: string }>();
    if (!cr || cr.task_id !== task.id || cr.student_id !== task.student_id) throw notFound("变更请求不存在或不属于该任务");
    if (cr.github_repository_id !== link.github_repository_id) throw conflict("变更请求不属于当前关联仓库", "REPOSITORY_MISMATCH");
    if (!["open", "merged"].includes(cr.status) || !isCommitSha(cr.head_commit_sha)) throw conflict("变更请求尚未发布，没有可执行的提交", "CHANGE_REQUEST_NOT_READY");
    executedCommitSha = cr.head_commit_sha;
  } else {
    if (!isCommitSha(body.executedCommitSha)) throw bad("提交 SHA 需为 40 位小写十六进制");
    try {
      executedCommitSha = await resolveCommitSha({
        installationId: link.installation_id, repositoryId: link.github_repository_id, fullName: link.full_name, ref: body.executedCommitSha,
      });
    } catch (error) {
      if (error instanceof GithubNotConfiguredError) throw new RunServiceError(503, "GitHub App 尚未配置，无法校验提交", "GITHUB_NOT_CONFIGURED");
      if (error instanceof GithubCommitNotFoundError) throw bad("提交不存在于该仓库", "COMMIT_NOT_FOUND");
      throw new RunServiceError(503, "暂时无法校验提交，请稍后重试", "GITHUB_UNAVAILABLE");
    }
    if (executedCommitSha !== body.executedCommitSha) throw bad("提交 SHA 校验不一致", "COMMIT_NOT_FOUND");
  }

  const egress = parseJson<EgressPolicy | null>(dataset.egress_policy_json as string, null);
  if (!egress) throw new RunServiceError(503, "数据集外发策略损坏", "EGRESS_POLICY_CORRUPT");
  const spec: RunSpec = {
    schema: "tanyan.runspec/v1",
    taskId: task.id,
    taskVersion: task.confirmed_version,
    taskSnapshotSha256: version.snapshot_sha256,
    studentId: task.student_id,
    repository: { provider: "github", repositoryId: link.github_repository_id, fullName: link.full_name },
    executedCommitSha,
    changeRequestId,
    entrypoint: {
      id: entrypointId,
      argv: parseJson<string[]>(entrypoint.argv_json as string, []),
      imageRef: entrypoint.image_ref as string,
      params,
    },
    dataset: {
      versionId: datasetVersionId,
      manifestSha256: dataset.manifest_sha256 as string,
      splitManifestSha256: dataset.split_manifest_sha256 as string,
      mount: "read_only",
    },
    evaluationProtocolSha256: entrypoint.evaluation_protocol_sha256 as string,
    resources,
    network: "deny",
    egress,
  };
  const sha256 = await runSpecSha256(spec);
  const canonical = canonicalJson(spec as unknown as JsonValue);
  const runId = newId("run");
  try {
    await d1.batch([
      d1.prepare(`INSERT OR IGNORE INTO run_specs (sha256, canonical_json, task_id, task_version, student_id, github_repository_id,
        executed_commit_sha, entrypoint_id, dataset_version_id, change_request_id, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(sha256, canonical, task.id, task.confirmed_version, task.student_id, link.github_repository_id,
          executedCommitSha, entrypointId, datasetVersionId, changeRequestId, actor.id),
      ...newRunStatements(d1, { runId, sha256, taskId: task.id, studentId: task.student_id, key, actor, payload: { action: "created" } }),
    ]);
  } catch (error) {
    const existing = await d1.prepare("SELECT * FROM runs WHERE idempotency_key = ?").bind(key).first<RunRow>();
    if (existing && existing.task_id === task.id && existing.created_by_user_id === actor.id) {
      return { runId: existing.id, runSpecSha256: existing.run_spec_sha256, attempt: existing.attempt, status: existing.status, replayed: true };
    }
    if (String(error).includes("UNIQUE")) throw conflict("运行创建冲突，请重试", "CREATE_CONFLICT");
    throw error;
  }
  const created = await loadRun(d1, runId);
  return { runId, runSpecSha256: sha256, attempt: created?.attempt ?? 1, status: "awaiting_approval" as RunStatus, replayed: false };
}

function newRunStatements(d1: D1Database, input: {
  runId: string; sha256: string; taskId: string; studentId: string; key: string; actor: AppUser; payload: Record<string, JsonValue>;
}) {
  return [
    d1.prepare(`INSERT INTO runs (id, run_spec_sha256, attempt, task_id, student_id, status, idempotency_key, submit_tag, created_by_user_id)
      VALUES (?, ?, (SELECT COALESCE(MAX(attempt), 0) + 1 FROM runs WHERE run_spec_sha256 = ?), ?, ?, 'awaiting_approval', ?, ?, ?)`)
      .bind(input.runId, input.sha256, input.sha256, input.taskId, input.studentId, input.key, `tanyan-${input.runId}`, input.actor.id),
    d1.prepare(`INSERT INTO run_events (run_id, sequence, from_status, to_status, actor_type, actor_id, payload_json)
      VALUES (?, 1, '', 'awaiting_approval', 'user', ?, ?)`)
      .bind(input.runId, String(input.actor.id), JSON.stringify(input.payload)),
  ];
}

async function runForActor(d1: D1Database, actor: AppUser, runIdValue: unknown) {
  const runId = identifier(runIdValue, "运行");
  const run = await loadRun(d1, runId);
  if (!run) throw notFound("运行不存在");
  if (!(await canViewStudent(actor, run.student_id))) throw forbidden("无权操作该学生的运行");
  return run;
}

export async function approveRun(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  const run = await runForActor(d1, actor, body.runId);
  if (!isSha256(body.runSpecSha256)) throw bad("请回传已审阅的运行规范 sha256");
  if (!(await canReviewStudent(actor, run.student_id))) throw forbidden("只有可审核该学生的导师或超级管理员可以批准运行");
  if (run.status !== "awaiting_approval") throw conflict("运行当前不在待批准状态", "NOT_AWAITING_APPROVAL");
  // The approval binds to the exact spec the reviewer saw (T09/T10).
  if (body.runSpecSha256 !== run.run_spec_sha256) throw conflict("运行规范已变化，请重新审阅后再批准", "SPEC_HASH_MISMATCH");
  const { createdByUserId } = await loadSpec(d1, run.run_spec_sha256);
  if (actor.id === createdByUserId || actor.id === run.created_by_user_id) throw forbidden("不能批准自己创建的运行");
  const note = text(body.note, "批准说明", 1000, false);
  const approvalId = newId("apr");
  const guard = runGuard(run);
  const ok = await commitGuarded(d1, [
    d1.prepare(`INSERT INTO run_approvals (id, run_spec_sha256, approved_by_user_id, note) SELECT ?, ?, ?, ? WHERE ${guard.sql}`)
      .bind(approvalId, run.run_spec_sha256, actor.id, note, ...guard.binds),
    ...transitionStatements(d1, run, {
      path: ["queued"], actor: { type: "user", id: String(actor.id) },
      payload: { action: "approved", approvalId, runSpecSha256: run.run_spec_sha256 },
      set: { approval_id: approvalId, queued_at: nowIso() },
    }),
  ]);
  if (!ok) throw STALE();
  return { runId: run.id, approvalId, status: "queued" as RunStatus };
}

export async function revokeApproval(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  const run = await runForActor(d1, actor, body.runId);
  if (!(await canReviewStudent(actor, run.student_id))) throw forbidden("只有可审核该学生的导师或超级管理员可以撤销批准");
  if (!run.approval_id) throw conflict("该运行没有批准记录", "NO_APPROVAL");
  if (isTerminal(run.status)) throw conflict("运行已结束", "RUN_TERMINAL");
  const approval = await d1.prepare("SELECT revoked_at FROM run_approvals WHERE id = ?").bind(run.approval_id).first<{ revoked_at: string | null }>();
  if (!approval || approval.revoked_at) throw conflict("批准已撤销", "APPROVAL_REVOKED");
  const guard = runGuard(run);
  const revoke = d1.prepare(`UPDATE run_approvals SET revoked_at = CURRENT_TIMESTAMP, revoked_by_user_id = ?
    WHERE id = ? AND revoked_at IS NULL AND ${guard.sql}`).bind(actor.id, run.approval_id, ...guard.binds);
  const { path, set, audit } = cancelPlan(run, actor.id);
  const ok = await commitGuarded(d1, [revoke, ...transitionStatements(d1, run, {
    path, set, audit, actor: { type: "user", id: String(actor.id) },
    payload: { action: "approval_revoked", approvalId: run.approval_id },
  })]);
  if (!ok) throw STALE();
  return { runId: run.id, status: path.length ? path[path.length - 1] : run.status, cancelRequested: true };
}

/** Pre-dispatch runs are canceled outright; in-flight runs get a cancel request
 * that the runner sees on its next heartbeat. "collecting" cannot move to
 * cancel_requested, so only the flag is set there. */
function cancelPlan(run: RunRow, userId: number | null): { path: RunStatus[]; set: Record<string, SetValue>; audit: boolean } {
  const flag: Record<string, SetValue> = run.cancel_requested_at ? {} : { cancel_requested_at: nowIso(), cancel_requested_by_user_id: userId };
  if (run.status === "awaiting_approval" || run.status === "queued") return { path: ["canceled"], set: { ...flag, ended_at: nowIso() }, audit: false };
  if (run.status === "cancel_requested") return { path: [], set: flag, audit: false };
  if (canTransition(RUN_TRANSITIONS, run.status, "cancel_requested")) return { path: ["cancel_requested"], set: flag, audit: false };
  return { path: [], set: flag, audit: true };
}

export async function cancelRun(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  const run = await runForActor(d1, actor, body.runId);
  if (isTerminal(run.status)) throw conflict("运行已结束，无法取消", "RUN_TERMINAL");
  if (run.status === "cancel_requested") return { runId: run.id, status: run.status, replayed: true };
  const { path, set, audit } = cancelPlan(run, actor.id);
  const ok = await commitGuarded(d1, transitionStatements(d1, run, {
    path, set, audit, actor: { type: "user", id: String(actor.id) }, payload: { action: "cancel" },
  }));
  if (!ok) throw STALE();
  return { runId: run.id, status: path.length ? path[path.length - 1] : run.status, replayed: false };
}

export async function rerunRun(d1: D1Database, actor: AppUser, body: Record<string, unknown>) {
  const key = idempotencyKey(body.idempotencyKey);
  const source = await runForActor(d1, actor, body.runId);
  const replay = await d1.prepare("SELECT * FROM runs WHERE idempotency_key = ?").bind(key).first<RunRow>();
  if (replay) {
    if (replay.run_spec_sha256 !== source.run_spec_sha256 || replay.created_by_user_id !== actor.id) throw conflict("幂等键已用于其他运行", "IDEMPOTENCY_CONFLICT");
    return { runId: replay.id, runSpecSha256: replay.run_spec_sha256, attempt: replay.attempt, status: replay.status, replayed: true };
  }
  if (!isTerminal(source.status)) throw conflict("只能重跑已结束的运行", "RUN_NOT_TERMINAL");
  await assertActiveStudent(d1, source.student_id);
  const { spec } = await loadSpec(d1, source.run_spec_sha256);
  const task = await confirmedTask(d1, spec.taskId);
  if (task.status !== "confirmed" || task.confirmed_version !== spec.taskVersion) throw conflict("研究任务已修改，请基于新确认版本创建运行", "TASK_CHANGED");
  const reusable = await d1.prepare(`SELECT
      (SELECT active FROM registered_entrypoints WHERE id = ?) AS entrypoint_active,
      (SELECT active FROM dataset_versions WHERE id = ?) AS dataset_active,
      (SELECT COUNT(*) FROM dataset_grants WHERE dataset_version_id = ? AND student_id = ? AND revoked_at IS NULL) AS grants`)
    .bind(spec.entrypoint.id, spec.dataset.versionId, spec.dataset.versionId, spec.studentId)
    .first<{ entrypoint_active: number | null; dataset_active: number | null; grants: number }>();
  if (reusable?.entrypoint_active !== 1 || reusable?.dataset_active !== 1 || !reusable?.grants) {
    throw conflict("入口、数据集或数据授权已失效，不能重跑", "RERUN_NOT_ALLOWED");
  }
  const runId = newId("run");
  try {
    await d1.batch(newRunStatements(d1, {
      runId, sha256: source.run_spec_sha256, taskId: source.task_id, studentId: source.student_id, key, actor,
      payload: { action: "rerun", sourceRunId: source.id },
    }));
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw conflict("重跑冲突，请重试", "CREATE_CONFLICT");
    throw error;
  }
  const created = await loadRun(d1, runId);
  return { runId, runSpecSha256: source.run_spec_sha256, attempt: created?.attempt ?? source.attempt + 1, status: "awaiting_approval" as RunStatus, replayed: false };
}

// ---------------------------------------------------------------------------
// Lab protocol (compute runners)
// ---------------------------------------------------------------------------

/** Reasons the run may no longer execute (T12). Empty means still authorized. */
export async function authorizationProblems(d1: D1Database, runId: string) {
  const row = await d1.prepare(`SELECT r.student_id, r.run_spec_sha256,
      st.active AS student_active, t.status AS task_status,
      a.id AS approval_row, a.revoked_at AS approval_revoked_at, a.run_spec_sha256 AS approval_spec,
      u.active AS approver_active, u.role AS approver_role, u.student_id AS approver_student_id,
      (SELECT COUNT(*) FROM mentor_student_assignments m WHERE m.mentor_user_id = a.approved_by_user_id
        AND m.student_id = r.student_id AND m.active = 1 AND m.can_review = 1) AS approver_assignments,
      g.student_id AS grant_student, g.revoked_at AS grant_revoked_at,
      d.active AS dataset_active, e.active AS entrypoint_active,
      l.status AS link_status, l.github_repository_id AS link_repository_id, s.github_repository_id AS spec_repository_id
    FROM runs r
    JOIN run_specs s ON s.sha256 = r.run_spec_sha256
    JOIN students st ON st.id = r.student_id
    JOIN research_tasks t ON t.id = r.task_id
    JOIN dataset_versions d ON d.id = s.dataset_version_id
    JOIN registered_entrypoints e ON e.id = s.entrypoint_id
    LEFT JOIN run_approvals a ON a.id = r.approval_id
    LEFT JOIN app_users u ON u.id = a.approved_by_user_id
    LEFT JOIN dataset_grants g ON g.dataset_version_id = s.dataset_version_id AND g.student_id = r.student_id
    LEFT JOIN repository_links l ON l.student_id = r.student_id
    WHERE r.id = ?`).bind(runId).first<Record<string, unknown>>();
  if (!row) return ["运行记录不完整"];
  const problems: string[] = [];
  if (row.student_active !== 1) problems.push("学生已停用");
  if (row.task_status === "canceled") problems.push("研究任务已取消");
  if (!row.approval_row || row.approval_revoked_at || row.approval_spec !== row.run_spec_sha256) problems.push("批准无效或已撤销");
  else if (row.approver_active !== 1 || row.approver_student_id === row.student_id
    || (row.approver_role !== "superadmin" && !Number(row.approver_assignments))) problems.push("批准人已失去审核权限");
  if (!row.grant_student || row.grant_revoked_at) problems.push("数据授权已撤销");
  if (row.dataset_active !== 1) problems.push("数据集已停用");
  if (row.entrypoint_active !== 1) problems.push("入口已停用");
  if (row.link_status !== "active" || row.link_repository_id !== row.spec_repository_id) problems.push("仓库关联已撤销");
  return problems;
}

type ClaimWork = Extract<ComputeClaimResponse, { work: object }>["work"];

export async function claimRun(d1: D1Database, runner: LabRunner): Promise<ComputeClaimResponse> {
  const now = nowIso();
  // 1. Our own runs whose lease lapsed mid-flight: never resubmit blindly (T11).
  const stale = await d1.prepare(`SELECT * FROM runs WHERE runner_id = ?
      AND status IN ('dispatching', 'running', 'collecting', 'cancel_requested', 'reconciling')
      AND (lease_expires_at IS NULL OR lease_expires_at < ?)
    ORDER BY updated_at, id LIMIT 5`).bind(runner.id, now).all<RunRow>();
  for (const run of stale.results) {
    const expires = leaseExpiry();
    const ok = await commitGuarded(d1, transitionStatements(d1, run, {
      path: run.status === "reconciling" ? [] : ["reconciling"],
      audit: run.status === "reconciling",
      actor: { type: "runner", id: runner.id },
      payload: { action: "reconcile_claim", leaseEpoch: run.lease_epoch + 1, previousStatus: run.status },
      set: { lease_epoch: { raw: "lease_epoch + 1" }, lease_expires_at: expires, heartbeat_at: now },
    }));
    if (!ok) continue;
    return { work: await claimWork(d1, { ...run, status: "reconciling", lease_epoch: run.lease_epoch + 1 }, "reconcile", expires, null) };
  }

  // 2. Oldest queued run on a dataset this runner hosts, still fully authorized.
  const queued = await d1.prepare(`SELECT r.* FROM runs r
      JOIN run_specs s ON s.sha256 = r.run_spec_sha256
      JOIN dataset_versions d ON d.id = s.dataset_version_id
    WHERE r.status = 'queued' AND d.runner_id = ? AND d.active = 1
    ORDER BY r.queued_at, r.id LIMIT 20`).bind(runner.id).all<RunRow>();
  for (const run of queued.results) {
    if ((await authorizationProblems(d1, run.id)).length) continue;
    const { spec } = await loadSpec(d1, run.run_spec_sha256);
    const repository = await mintReadAccess(d1, run.student_id, spec);
    const expires = leaseExpiry();
    const ok = await commitGuarded(d1, transitionStatements(d1, run, {
      path: ["dispatching"],
      actor: { type: "runner", id: runner.id },
      payload: { action: "claim", leaseEpoch: run.lease_epoch + 1 },
      set: { runner_id: runner.id, lease_epoch: { raw: "lease_epoch + 1" }, lease_expires_at: expires, heartbeat_at: now, started_at: now },
    }));
    if (!ok) continue;
    return { work: await claimWork(d1, { ...run, status: "dispatching", lease_epoch: run.lease_epoch + 1 }, "execute", expires, repository) };
  }
  return { work: null };
}

async function mintReadAccess(d1: D1Database, studentId: string, spec: RunSpec) {
  const link = await activeLink(d1, studentId);
  if (!link || link.github_repository_id !== spec.repository.repositoryId) return null;
  try {
    return await mintRepositoryReadToken({ installationId: link.installation_id, repositoryId: link.github_repository_id, fullName: link.full_name });
  } catch (error) {
    if (error instanceof GithubNotConfiguredError) return null;
    throw new RunServiceError(503, "暂时无法签发仓库只读凭据", "GITHUB_UNAVAILABLE");
  }
}

async function claimWork(d1: D1Database, run: RunRow, mode: "execute" | "reconcile", leaseExpiresAt: string, repository: ClaimWork["repository"]): Promise<ClaimWork> {
  const { spec } = await loadSpec(d1, run.run_spec_sha256);
  return {
    mode, runId: run.id, attempt: run.attempt, submitTag: run.submit_tag, leaseEpoch: run.lease_epoch, leaseExpiresAt,
    approvalId: run.approval_id ?? "", runSpecSha256: run.run_spec_sha256, spec,
    repository: mode === "execute" ? repository : null, schedulerJobId: run.scheduler_job_id,
  };
}

async function leasedRun(d1: D1Database, runner: LabRunner, body: Record<string, unknown>) {
  if (typeof body.runId !== "string" || !ID_PATTERN.test(body.runId)) throw bad("runId 无效");
  if (typeof body.leaseEpoch !== "number" || !Number.isSafeInteger(body.leaseEpoch)) throw bad("leaseEpoch 无效");
  const run = await loadRun(d1, body.runId);
  if (!run || run.runner_id !== runner.id || run.lease_epoch !== body.leaseEpoch) throw leaseLost();
  return run;
}

function schedulerJobId(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw bad("schedulerJobId 无效");
  return value;
}

export async function heartbeatRun(d1: D1Database, runner: LabRunner, body: Record<string, unknown>) {
  const run = await leasedRun(d1, runner, body);
  if (isTerminal(run.status)) throw leaseLost();
  if (run.status === "reconciling") throw conflict("请先完成对账", "RECONCILE_REQUIRED");
  const phase = body.phase;
  if (phase !== "dispatching" && phase !== "running" && phase !== "collecting") throw bad("phase 无效");
  const jobId = schedulerJobId(body.schedulerJobId);
  const problems = await authorizationProblems(d1, run.id);
  const now = Date.now();
  const expires = leaseExpiry(now);
  const set: Record<string, SetValue> = { lease_expires_at: expires, heartbeat_at: new Date(now).toISOString() };
  if (jobId !== undefined && jobId !== run.scheduler_job_id) set.scheduler_job_id = jobId;
  let path: RunStatus[] = [];
  let audit = false;
  let payload: Record<string, JsonValue> = { action: "heartbeat", phase };
  if (problems.length && !run.cancel_requested_at) {
    // Revocation during the run (T12): request cancellation, audited.
    set.cancel_requested_at = new Date(now).toISOString();
    payload = { action: "authorization_revoked", reasons: problems };
    if (canTransition(RUN_TRANSITIONS, run.status, "cancel_requested")) path = ["cancel_requested"];
    else audit = true;
  } else if (run.status !== "cancel_requested" && phase !== run.status) {
    const order = ["dispatching", "running", "collecting"];
    if (order.indexOf(phase) < order.indexOf(run.status) || !canTransition(RUN_TRANSITIONS, run.status, phase)) {
      throw conflict(`不能从 ${run.status} 回报 ${phase}`, "INVALID_PHASE");
    }
    path = [phase];
  }
  if (jobId !== undefined && jobId !== run.scheduler_job_id) payload.schedulerJobId = jobId;
  const ok = await commitGuarded(d1, transitionStatements(d1, run, { path, audit, set, payload, actor: { type: "runner", id: runner.id } }));
  if (!ok) throw leaseLost();
  return { leaseExpiresAt: expires, cancelRequested: Boolean(run.cancel_requested_at || set.cancel_requested_at) };
}

export async function reconcileRun(d1: D1Database, runner: LabRunner, body: Record<string, unknown>): Promise<ComputeReconcileResponse> {
  const run = await leasedRun(d1, runner, body);
  if (run.status !== "reconciling") {
    if (isTerminal(run.status)) throw leaseLost();
    throw conflict("运行不在对账状态", "NOT_RECONCILING");
  }
  if (typeof body.found !== "boolean") throw bad("found 无效");
  const jobId = schedulerJobId(body.schedulerJobId);
  const state = body.schedulerState ?? "unknown";
  if (!["pending", "running", "finished", "failed", "canceled", "unknown"].includes(state as string)) throw bad("schedulerState 无效");
  const problems = await authorizationProblems(d1, run.id);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const cancel = Boolean(run.cancel_requested_at) || problems.length > 0;
  let to: RunStatus | null;
  if (!body.found) to = cancel ? "canceled" : "dispatching";
  else if (state === "pending" || state === "running") to = cancel ? "cancel_requested" : "running";
  else if (state === "finished") to = "collecting";
  else if (state === "failed") to = "failed";
  else if (state === "canceled") to = "canceled";
  else to = null;
  const terminal = to !== null && isTerminal(to);
  const expires = terminal ? null : leaseExpiry(nowMs);
  const set: Record<string, SetValue> = { lease_expires_at: expires, heartbeat_at: now };
  if (jobId !== undefined) set.scheduler_job_id = jobId;
  if (cancel && !run.cancel_requested_at) set.cancel_requested_at = now;
  if (terminal) set.ended_at = now;
  if (to === "failed") set.failure_reason = "调度器报告作业失败（对账）";
  if (to === "canceled") set.failure_reason = body.found ? "调度器报告作业已取消（对账）" : "已请求取消，调度器中没有对应作业";
  const ok = await commitGuarded(d1, transitionStatements(d1, run, {
    path: to ? [to] : [], audit: !to, set, actor: { type: "runner", id: runner.id },
    payload: { action: "reconcile", found: body.found, schedulerState: state as string, schedulerJobId: jobId ?? null, ...(problems.length ? { reasons: problems } : {}) },
  }));
  if (!ok) throw leaseLost();
  // A terminal status ends the lease now (contracts: ComputeReconcileResponse).
  const response: ComputeReconcileResponse = { status: to ?? run.status, leaseExpiresAt: expires ?? now, cancelRequested: cancel };
  // The runner must (re)submit: it needs code access it may no longer hold.
  if (to === "dispatching") {
    const { spec } = await loadSpec(d1, run.run_spec_sha256);
    response.repository = await mintReadAccess(d1, run.student_id, spec).catch(() => null);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Completion: manifest verification, egress re-check, metrics
// ---------------------------------------------------------------------------

// Same list as the runner's gate (contracts), so the re-check never diverges.
const IMAGE_EXTENSIONS = new Set<string>(EGRESS_IMAGE_EXTENSIONS);

export function extensionOf(path: string) {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function contentTypeFor(path: string) {
  const types: Record<string, string> = {
    ".json": "application/json", ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8",
    ".txt": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".pdf": "application/pdf",
  };
  return types[extensionOf(path)] ?? "application/octet-stream";
}

class ManifestError extends Error {
  code: "MANIFEST_INVALID" | "MANIFEST_MISMATCH";
  constructor(code: ManifestError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function shapeError(message: string): never {
  throw new ManifestError("MANIFEST_INVALID", message);
}

function str(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) shapeError(`manifest 字段 ${label} 无效`);
  return value;
}

/** Strict shape check; returns a normalized copy containing only known fields. */
function parseManifest(value: unknown): RunManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) shapeError("manifest 不是对象");
  const m = value as Record<string, unknown>;
  if (m.schema !== "tanyan.manifest/v1") shapeError("manifest schema 不是 tanyan.manifest/v1");
  const obj = (input: unknown, label: string) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) shapeError(`manifest 字段 ${label} 无效`);
    return input as Record<string, unknown>;
  };
  const int = (input: unknown, label: string) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input)) shapeError(`manifest 字段 ${label} 无效`);
    return input;
  };
  const repository = obj(m.repository, "repository");
  const inputs = obj(m.inputs, "inputs");
  const environment = obj(m.environment, "environment");
  const execution = obj(m.execution, "execution");
  if (!Array.isArray(inputs.seeds) || inputs.seeds.length > 100) shapeError("manifest 字段 inputs.seeds 无效");
  if (!Array.isArray(m.artifacts) || m.artifacts.length > 500) shapeError("manifest 产物需为不超过 500 项的列表");
  const artifacts: ManifestArtifact[] = m.artifacts.map((raw, index) => {
    const item = obj(raw, `artifacts[${index}]`);
    if (!EGRESS_DECISIONS.includes(item.egressDecision as EgressDecision)) shapeError(`产物 ${index + 1} 的外发决定无效`);
    // Non-regular entries (symlinks, special files) carry no content hash; the
    // contract allows "" only for rejected entries, which are never published.
    if (!isSha256(item.sha256) && !(item.sha256 === "" && item.egressDecision === "rejected")) shapeError(`产物 ${index + 1} 的 sha256 无效`);
    if (!ARTIFACT_KINDS.includes(item.kind as ArtifactKind)) shapeError(`产物 ${index + 1} 的类型无效`);
    const sizeBytes = int(item.sizeBytes, `artifacts[${index}].sizeBytes`);
    if (sizeBytes < 0) shapeError(`产物 ${index + 1} 的大小无效`);
    return {
      // Raw path kept for the record; policy below decides whether it is safe.
      relativePath: str(item.relativePath, `artifacts[${index}].relativePath`, 1024),
      sha256: item.sha256, sizeBytes, kind: item.kind as ArtifactKind,
      egressDecision: item.egressDecision as EgressDecision,
      egressReason: str(item.egressReason ?? "", `artifacts[${index}].egressReason`, 500),
      labLocator: str(item.labLocator ?? "", `artifacts[${index}].labLocator`, 1024),
    };
  });
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (!artifact.relativePath) shapeError("产物路径不能为空");
    if (paths.has(artifact.relativePath)) shapeError(`产物路径重复：${artifact.relativePath}`);
    paths.add(artifact.relativePath);
  }
  const metricsArtifactPath = m.metricsArtifactPath === null || m.metricsArtifactPath === undefined ? null : str(m.metricsArtifactPath, "metricsArtifactPath", 1024);
  return {
    schema: "tanyan.manifest/v1",
    runId: str(m.runId, "runId", 80),
    attempt: int(m.attempt, "attempt"),
    runSpecSha256: str(m.runSpecSha256, "runSpecSha256", 64),
    approvalId: str(m.approvalId, "approvalId", 80),
    repository: { repositoryId: int(repository.repositoryId, "repository.repositoryId"), executedCommitSha: str(repository.executedCommitSha, "repository.executedCommitSha", 40) },
    inputs: {
      datasetVersionId: str(inputs.datasetVersionId, "inputs.datasetVersionId", 80),
      manifestSha256: str(inputs.manifestSha256, "inputs.manifestSha256", 64),
      splitManifestSha256: str(inputs.splitManifestSha256, "inputs.splitManifestSha256", 64),
      evaluationProtocolSha256: str(inputs.evaluationProtocolSha256, "inputs.evaluationProtocolSha256", 64),
      seeds: inputs.seeds.map((seed, index) => int(seed, `inputs.seeds[${index}]`)),
    },
    environment: {
      imageDigest: str(environment.imageDigest, "environment.imageDigest", 300),
      driverVersion: str(environment.driverVersion ?? "", "environment.driverVersion", 120),
      gpuModel: str(environment.gpuModel ?? "", "environment.gpuModel", 120),
    },
    execution: {
      runnerId: str(execution.runnerId, "execution.runnerId", 80),
      schedulerJobId: str(execution.schedulerJobId ?? "", "execution.schedulerJobId", 128),
      submitTag: str(execution.submitTag, "execution.submitTag", 120),
      entrypointId: str(execution.entrypointId, "execution.entrypointId", 80),
      startedAt: str(execution.startedAt ?? "", "execution.startedAt", 40),
      endedAt: str(execution.endedAt ?? "", "execution.endedAt", 40),
      exitCode: execution.exitCode === null ? null : int(execution.exitCode, "execution.exitCode"),
    },
    metricsArtifactPath,
    artifacts,
  };
}

function verifyManifestIdentity(manifest: RunManifest, run: RunRow, spec: RunSpec, runner: LabRunner, exitCode: number | null) {
  const digest = spec.entrypoint.imageRef.slice(spec.entrypoint.imageRef.indexOf("@") + 1);
  const checks: [string, unknown, unknown][] = [
    ["runId", manifest.runId, run.id],
    ["attempt", manifest.attempt, run.attempt],
    ["runSpecSha256", manifest.runSpecSha256, run.run_spec_sha256],
    ["approvalId", manifest.approvalId, run.approval_id],
    ["repository.repositoryId", manifest.repository.repositoryId, spec.repository.repositoryId],
    ["repository.executedCommitSha", manifest.repository.executedCommitSha, spec.executedCommitSha],
    ["inputs.datasetVersionId", manifest.inputs.datasetVersionId, spec.dataset.versionId],
    ["inputs.manifestSha256", manifest.inputs.manifestSha256, spec.dataset.manifestSha256],
    ["inputs.splitManifestSha256", manifest.inputs.splitManifestSha256, spec.dataset.splitManifestSha256],
    ["inputs.evaluationProtocolSha256", manifest.inputs.evaluationProtocolSha256, spec.evaluationProtocolSha256],
    ["execution.runnerId", manifest.execution.runnerId, runner.id],
    ["execution.submitTag", manifest.execution.submitTag, run.submit_tag],
    ["execution.entrypointId", manifest.execution.entrypointId, spec.entrypoint.id],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) throw new ManifestError("MANIFEST_MISMATCH", `manifest 字段 ${field} 与运行规范不一致`);
  }
  if (manifest.environment.imageDigest !== digest && manifest.environment.imageDigest !== spec.entrypoint.imageRef) {
    throw new ManifestError("MANIFEST_MISMATCH", "manifest 字段 environment.imageDigest 与运行规范不一致");
  }
  // Null-aware: null (unknown) only matches null.
  if (manifest.execution.exitCode !== exitCode) {
    throw new ManifestError("MANIFEST_MISMATCH", "manifest 字段 execution.exitCode 与回报不一致");
  }
}

type ArtifactPlan = ManifestArtifact & { id: string; finalDecision: EgressDecision; finalReason: string; bytes: Uint8Array | null; safePath: string | null };

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Re-applies the dataset egress policy. Decisions may only get stricter:
 * published → held (or rejected for unsafe paths), never the reverse. */
async function planArtifacts(manifest: RunManifest, policy: EgressPolicy, publishedFiles: unknown): Promise<ArtifactPlan[]> {
  const inline = new Map<string, string>();
  if (publishedFiles !== undefined && publishedFiles !== null) {
    if (!Array.isArray(publishedFiles) || publishedFiles.length > 500) throw bad("publishedFiles 无效");
    for (const file of publishedFiles) {
      if (!file || typeof file !== "object") throw bad("publishedFiles 无效");
      const { relativePath, contentBase64 } = file as Record<string, unknown>;
      if (typeof relativePath !== "string" || typeof contentBase64 !== "string") throw bad("publishedFiles 无效");
      if (!inline.has(relativePath)) inline.set(relativePath, contentBase64);
    }
  }
  let publishedTotal = 0;
  const plans: ArtifactPlan[] = [];
  for (const artifact of manifest.artifacts) {
    let decision = artifact.egressDecision;
    let reason = artifact.egressReason;
    let safePath: string | null = null;
    let bytes: Uint8Array | null = null;
    try { safePath = normalizeRepoPath(artifact.relativePath); } catch { safePath = null; }
    const downgrade = (to: EgressDecision, why: string) => {
      if (decision === "published" || (to === "rejected" && decision === "held")) { decision = to; reason = why; }
    };
    if (!safePath) downgrade("rejected", "平台复核：路径越界或不规范");
    if (decision === "published") {
      const extension = extensionOf(artifact.relativePath);
      if (!policy.allowedExtensions.includes(extension)) downgrade("held", `平台复核：扩展名 ${extension || "(无)"} 不在白名单`);
      else if (IMAGE_EXTENSIONS.has(extension) && !policy.allowImages) downgrade("held", "平台复核：图片默认不外发");
      else if (artifact.sizeBytes > policy.maxFileBytes || artifact.sizeBytes > LIMITS.maxPublishedArtifactBytes) downgrade("held", "平台复核：超过单文件上限");
      else if (publishedTotal + artifact.sizeBytes > policy.maxTotalBytes) downgrade("held", "平台复核：超过外发总量上限");
    }
    if (decision === "published") {
      const encoded = inline.get(artifact.relativePath);
      if (encoded === undefined) downgrade("held", "平台复核：未收到文件内容");
      else {
        try { bytes = decodeBase64(encoded); } catch { bytes = null; }
        if (!bytes || bytes.byteLength !== artifact.sizeBytes || await sha256Hex(bytes) !== artifact.sha256) {
          bytes = null;
          downgrade("held", "平台复核：文件内容与 manifest 哈希不一致");
        }
      }
    }
    if (decision === "published") publishedTotal += artifact.sizeBytes;
    else bytes = null;
    plans.push({ ...artifact, id: newId("art"), finalDecision: decision, finalReason: reason, bytes, safePath });
  }
  return plans;
}

function evaluateMetrics(manifest: RunManifest, plans: ArtifactPlan[], spec: RunSpec, outcome: string, exitCode: number | null) {
  const notes: string[] = [];
  let metricsJson: string | null = null;
  let sourceId: string | null = null;
  let metricsValid = false;
  if (manifest.metricsArtifactPath === null) notes.push("没有 metrics 产物");
  else {
    const plan = plans.find((item) => item.relativePath === manifest.metricsArtifactPath);
    if (!plan) notes.push("声明的 metrics 产物不在产物列表中");
    else if (plan.kind !== "metrics") notes.push("声明的 metrics 产物类型不是 metrics");
    else if (plan.finalDecision !== "published" || !plan.bytes) notes.push(`metrics 产物未外发（${plan.finalReason || plan.finalDecision}）`);
    else {
      let parsed: unknown = undefined;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plan.bytes)); } catch { notes.push("metrics 不是有效 JSON"); }
      if (parsed !== undefined) {
        const result = validateMetricsFile(parsed);
        if (!result.ok) notes.push(`metrics 校验失败：${result.error}`);
        else if (result.metrics.evaluationProtocolSha256 !== spec.evaluationProtocolSha256) {
          notes.push(`评价协议不一致：规范 ${spec.evaluationProtocolSha256}，metrics ${result.metrics.evaluationProtocolSha256}；不能作为同协议对比`);
        } else {
          metricsValid = true;
          metricsJson = canonicalJson(result.metrics as unknown as JsonValue);
          sourceId = plan.id;
        }
      }
    }
  }
  let validity: "valid" | "invalid" | "unknown";
  if (manifest.metricsArtifactPath === null) validity = outcome === "completed" && exitCode === 0 ? "unknown" : "invalid";
  else validity = metricsValid && outcome === "completed" && exitCode === 0 ? "valid" : "invalid";
  if (outcome !== "completed") notes.push(`运行结果为 ${outcome}`);
  else if (exitCode === null) notes.push("退出码未知");
  else if (exitCode !== 0) notes.push(`退出码为 ${exitCode}`);
  return { metricsJson, sourceId, validity, notes: notes.join("；") };
}

function completionPath(run: RunRow, outcome: "completed" | "failed" | "canceled"): { path: RunStatus[]; reason: string } {
  if (outcome === "failed") return { path: ["failed"], reason: "" };
  if (outcome === "canceled") {
    if (run.status === "cancel_requested") return { path: ["canceled"], reason: "" };
    return { path: ["failed"], reason: "调度器报告已取消，但平台未请求取消" };
  }
  if (run.status === "cancel_requested") return { path: ["canceled"], reason: "完成前已请求取消，结果仅作记录" };
  if (run.status === "dispatching") return { path: ["running", "collecting", "completed"], reason: "" };
  if (run.status === "running") return { path: ["collecting", "completed"], reason: "" };
  return { path: ["completed"], reason: "" };
}

export async function completeRun(d1: D1Database, runner: LabRunner, body: Record<string, unknown>) {
  const run = await leasedRun(d1, runner, body);
  if (isTerminal(run.status)) return { status: run.status, replayed: true };
  if (run.status === "reconciling") throw conflict("请先完成对账", "RECONCILE_REQUIRED");
  const outcome = body.outcome;
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "canceled") throw bad("outcome 无效");
  if (body.exitCode !== null && (typeof body.exitCode !== "number" || !Number.isSafeInteger(body.exitCode))) throw bad("exitCode 无效");
  const exitCode = body.exitCode as number | null;
  const failureReason = text(body.failureReason, "失败原因", 1000, false);
  const { spec } = await loadSpec(d1, run.run_spec_sha256);
  const now = nowIso();
  const actor: Actor = { type: "runner", id: runner.id };
  const plan = completionPath(run, outcome);

  const failWith = async (code: ManifestError["code"] | "MANIFEST_REQUIRED", message: string) => {
    const path: RunStatus[] = ["failed"];
    const ok = await commitGuarded(d1, transitionStatements(d1, run, {
      path, actor, payload: { action: "complete_rejected", code, error: message },
      set: { exit_code: exitCode, failure_reason: `${code}: ${message}`, ended_at: now, lease_expires_at: null },
    }));
    if (!ok) throw leaseLost();
    return new RunServiceError(422, message, code);
  };

  let manifest: RunManifest | null = null;
  if (body.manifest !== null && body.manifest !== undefined) {
    try {
      if (canonicalJson(body.manifest).length > LIMITS.maxManifestBytes) shapeError("manifest 超过大小上限");
      manifest = parseManifest(body.manifest);
      verifyManifestIdentity(manifest, run, spec, runner, exitCode);
    } catch (error) {
      if (error instanceof ManifestError) throw await failWith(error.code, error.message);
      if (error instanceof TypeError) throw await failWith("MANIFEST_INVALID", "manifest 无法规范化");
      throw error;
    }
  } else if (outcome === "completed") {
    throw await failWith("MANIFEST_REQUIRED", "完成的运行必须附带 manifest");
  }

  const statements: D1PreparedStatement[] = [];
  const guard = runGuard(run);
  let summary: Record<string, JsonValue> = {};
  if (manifest) {
    const plans = await planArtifacts(manifest, spec.egress, body.publishedFiles);
    const metrics = evaluateMetrics(manifest, plans, spec, outcome, exitCode);
    const bucket = plans.some((item) => item.bytes) ? getRunArtifactBucket() : null;
    for (const item of plans) {
      let r2Key: string | null = null;
      if (item.bytes && item.safePath && bucket) {
        r2Key = artifactR2Key(run.id, item.safePath);
        await bucket.put(r2Key, item.bytes, {
          httpMetadata: { contentType: contentTypeFor(item.safePath) },
          customMetadata: { sha256: item.sha256, runId: run.id },
        });
      }
      statements.push(d1.prepare(`INSERT INTO run_artifacts (id, run_id, relative_path, sha256, size_bytes, kind, egress_decision, egress_reason, r2_key, lab_locator)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`)
        .bind(item.id, run.id, item.relativePath, item.sha256, item.sizeBytes, item.kind, item.finalDecision, item.finalReason,
          r2Key, item.labLocator, ...guard.binds));
    }
    const manifestCanonical = canonicalJson(manifest as unknown as JsonValue);
    statements.push(d1.prepare(`INSERT INTO run_results (run_id, manifest_sha256, manifest_json, metrics_json, metrics_source_artifact_id, technical_validity, validity_notes)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`)
      .bind(run.id, await sha256Hex(manifestCanonical), manifestCanonical, metrics.metricsJson, metrics.sourceId,
        metrics.validity, metrics.notes, ...guard.binds));
    statements.push(d1.prepare(`INSERT INTO result_reviews (run_id, state) SELECT ?, 'pending' WHERE ${guard.sql}`)
      .bind(run.id, ...guard.binds));
    summary = {
      technicalValidity: metrics.validity,
      artifacts: plans.map((item) => ({ relativePath: item.relativePath, egressDecision: item.finalDecision })),
    };
  }
  const reason = [plan.reason, failureReason].filter(Boolean).join("；");
  const ok = await commitGuarded(d1, [...statements, ...transitionStatements(d1, run, {
    path: plan.path, actor, payload: { action: "complete", outcome, exitCode, ...summary },
    set: { exit_code: exitCode, failure_reason: reason, ended_at: now, lease_expires_at: null },
  })]);
  if (!ok) throw leaseLost();
  return { status: plan.path[plan.path.length - 1], replayed: false, ...summary };
}

// ---------------------------------------------------------------------------
// Route helpers shared by the run endpoints
// ---------------------------------------------------------------------------

export function runJson(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function privateResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export function runFailure(error: unknown, fallback: string) {
  if (error instanceof RunServiceError) return runJson({ code: error.code, error: error.message }, error.status);
  console.error("run endpoint failure", error);
  return runJson({ code: "INTERNAL", error: fallback }, 500);
}

export async function readJsonBody(request: Request, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new RunServiceError(413, "请求内容过大", "PAYLOAD_TOO_LARGE");
  const raw = await request.text();
  if (raw.length > maxBytes) throw new RunServiceError(413, "请求内容过大", "PAYLOAD_TOO_LARGE");
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw bad("请求内容无效"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("请求内容无效");
  return body as Record<string, unknown>;
}
