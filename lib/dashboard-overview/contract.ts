import { monthlyDeliveryPhase } from "../monthly-delivery.ts";
import {
  overviewStates,
  overviewIssueStates,
  type MentorOverviewResponse,
  type OverviewAction,
  type OverviewOwner,
  type OverviewReasonCode,
  type OverviewSourceType,
  type OverviewState,
} from "./types.ts";

export const MENTOR_OVERVIEW_MAX_STUDENTS = 100;
export const MENTOR_OVERVIEW_MAX_JSON_BYTES = 250 * 1024;

const topLevelKeys = [
  "generatedAt",
  "timezone",
  "total",
  "counts",
  "weeklySubstantiveStudentCount",
  "students",
] as const;

const studentKeys = [
  "studentId",
  "displayName",
  "degreeLevel",
  "grade",
  "stage",
  "currentFocus",
  "cadenceDays",
  "primaryState",
  "primaryReasonCode",
  "primaryReasonLabel",
  "nextOwner",
  "primaryAction",
  "primaryActionTargetId",
  "issues",
  "additionalIssueCount",
  "counters",
  "latestSubstantiveTitle",
  "latestSubstantiveAt",
  "latestSubmittedAt",
  "nextAction",
  "nextActionDueDate",
  "paperPosition",
  "projectPosition",
  "recentSubstantive",
] as const;

const issueKeys = [
  "code",
  "state",
  "label",
  "owner",
  "dueDate",
  "occurredAt",
  "sourceType",
  "sourceId",
  "action",
  "actionTargetId",
] as const;

const counterKeys = ["actionableByMentor", "waitingForStudent", "blocked", "overdue"] as const;
const positionKeys = ["title", "stage", "status"] as const;
const recentProgressKeys = ["id", "title", "kind", "confirmedAt"] as const;

const reasonCodes = new Set<OverviewReasonCode>([
  "MILESTONE_BLOCKED",
  "MILESTONE_OVERDUE",
  "NEXT_ACTION_OVERDUE",
  "MENTOR_PROGRESS_REVIEW",
  "MENTOR_PROPOSAL_REVIEW",
  "MENTOR_GUIDANCE_VERIFY",
  "MENTOR_RESOLUTION_REVIEW",
  "STUDENT_RESOLUTION_CHANGES_REQUESTED",
  "STUDENT_CHANGES_REQUESTED",
  "STUDENT_GUIDANCE_ACTION",
  "STUDENT_CADENCE_OVERDUE",
  "ON_TRACK_RECENT_PROGRESS",
  "ON_TRACK_NEXT_ACTION",
  "INSUFFICIENT_NO_BASELINE",
  "INSUFFICIENT_NO_ACTION",
]);

const owners = new Set<OverviewOwner>(["mentor", "student", "coordination", "setup"]);
const actions = new Set<OverviewAction>([
  "resolve_blocker",
  "follow_up",
  "review_progress",
  "review_resolution",
  "view_resolution",
  "review_proposal",
  "verify_guidance",
  "view_guidance",
  "view_progress",
  "view_proposal",
  "view_student",
  "complete_profile",
]);
const sourceTypes = new Set<OverviewSourceType>([
  "progress",
  "proposal",
  "milestone",
  "guidance",
  "paper",
  "profile",
  "resolution",
]);
const states = new Set(overviewIssueStates);
const primaryStates = new Set<OverviewState>(overviewStates);

// Normalize snake_case, camelCase, kebab-case, and capitalization before matching.
// Values are intentionally not scanned: a legitimate title can contain words such as
// “审计” or “附件”, while these fields themselves must never be present in the summary.
const forbiddenNormalizedFieldNames = new Set([
  "attachment",
  "attachments",
  "attachmentbody",
  "attachmenturl",
  "storagekey",
  "filename",
  "files",
  "audit",
  "audits",
  "auditevent",
  "auditevents",
  "audithistory",
  "openid",
  "feishuopenid",
  "unionid",
  "feishuunionid",
  "feishuuserid",
  "email",
  "phone",
  "mobile",
  "contact",
  "contactinfo",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
  "tokenhash",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "cookie",
  "authorization",
  "summary",
  "evidence",
  "content",
  "rawcontent",
  "extractedtext",
  "snapshotjson",
  "reviewernote",
  "acceptancecriteria",
  "completionnote",
]);

function contractError(path: string, message: string): never {
  throw new Error(`导师总览响应契约失败：${path} ${message}`);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    contractError(path, "必须是对象");
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], path: string) {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) contractError(`${path}.${key}`, "不是响应契约允许的字段");
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) contractError(`${path}.${key}`, "是必填字段");
  }
}

function assertString(value: unknown, path: string, allowEmpty = true): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    contractError(path, allowEmpty ? "必须是字符串" : "必须是非空字符串");
  }
}

function assertNullableString(value: unknown, path: string) {
  if (value !== null) assertString(value, path);
}

function assertInteger(value: unknown, path: string, minimum = 0): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    contractError(path, `必须是大于或等于 ${minimum} 的整数`);
  }
}

function assertNullableInteger(value: unknown, path: string, minimum = 0) {
  if (value !== null) assertInteger(value, path, minimum);
}

function assertStringNumberOrNull(value: unknown, path: string) {
  if (value === null || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  contractError(path, "必须是字符串、有限数字或 null");
}

function assertMember<T extends string>(value: unknown, values: ReadonlySet<T>, path: string): asserts value is T {
  if (typeof value !== "string" || !values.has(value as T)) contractError(path, "不是允许的枚举值");
}

function normalizedFieldName(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

function assertNoSensitiveFields(value: unknown, path = "$", active = new WeakSet<object>()) {
  if (typeof value !== "object" || value === null) return;
  if (active.has(value)) contractError(path, "不能包含循环引用");
  active.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`, active));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenNormalizedFieldNames.has(normalizedFieldName(key))) {
        contractError(`${path}.${key}`, "是总览响应禁止返回的敏感或深层字段");
      }
      assertNoSensitiveFields(item, `${path}.${key}`, active);
    }
  }
  active.delete(value);
}

function assertIssue(value: unknown, path: string) {
  assertRecord(value, path);
  const hasResolutionKind = Object.prototype.hasOwnProperty.call(value, "resolutionKind");
  assertExactKeys(value, hasResolutionKind ? [...issueKeys, "resolutionKind"] : issueKeys, path);
  if (hasResolutionKind) assertMember(value.resolutionKind, new Set(["blocker", "next_action"]), `${path}.resolutionKind`);
  assertMember(value.code, reasonCodes, `${path}.code`);
  assertMember(value.state, states, `${path}.state`);
  assertString(value.label, `${path}.label`, false);
  assertMember(value.owner, owners, `${path}.owner`);
  assertNullableString(value.dueDate, `${path}.dueDate`);
  assertNullableString(value.occurredAt, `${path}.occurredAt`);
  assertMember(value.sourceType, sourceTypes, `${path}.sourceType`);
  assertStringNumberOrNull(value.sourceId, `${path}.sourceId`);
  assertMember(value.action, actions, `${path}.action`);
  assertStringNumberOrNull(value.actionTargetId, `${path}.actionTargetId`);
}

function assertPosition(value: unknown, path: string) {
  if (value === null) return;
  assertRecord(value, path);
  assertExactKeys(value, positionKeys, path);
  assertString(value.title, `${path}.title`, false);
  assertString(value.stage, `${path}.stage`, false);
  assertString(value.status, `${path}.status`, false);
}

function assertRecentProgress(value: unknown, path: string) {
  assertRecord(value, path);
  assertExactKeys(value, recentProgressKeys, path);
  assertInteger(value.id, `${path}.id`, 1);
  assertString(value.title, `${path}.title`, false);
  assertString(value.kind, `${path}.kind`, false);
  assertString(value.confirmedAt, `${path}.confirmedAt`, false);
}

// Optional per-student keys: present only when the server has the fact for this viewer.
const optionalStudentKeys = ["monthlyDelivery", "loopPending"] as const;

function assertStudent(value: unknown, path: string) {
  assertRecord(value, path);
  assertExactKeys(value, [...studentKeys, ...optionalStudentKeys.filter((key) => Object.hasOwn(value, key))], path);
  if (Object.hasOwn(value, "monthlyDelivery")) assertMonthlyDelivery(value.monthlyDelivery, `${path}.monthlyDelivery`);
  if (Object.hasOwn(value, "loopPending")) assertInteger(value.loopPending, `${path}.loopPending`);
  assertString(value.studentId, `${path}.studentId`, false);
  assertString(value.displayName, `${path}.displayName`, false);
  if (value.degreeLevel !== "博士" && value.degreeLevel !== "硕士") {
    contractError(`${path}.degreeLevel`, "必须是博士或硕士");
  }
  assertNullableInteger(value.grade, `${path}.grade`);
  assertString(value.stage, `${path}.stage`, false);
  assertString(value.currentFocus, `${path}.currentFocus`);
  assertNullableInteger(value.cadenceDays, `${path}.cadenceDays`, 1);
  assertMember(value.primaryState, primaryStates, `${path}.primaryState`);
  assertMember(value.primaryReasonCode, reasonCodes, `${path}.primaryReasonCode`);
  assertString(value.primaryReasonLabel, `${path}.primaryReasonLabel`, false);
  assertMember(value.nextOwner, owners, `${path}.nextOwner`);
  assertMember(value.primaryAction, actions, `${path}.primaryAction`);
  assertStringNumberOrNull(value.primaryActionTargetId, `${path}.primaryActionTargetId`);

  if (!Array.isArray(value.issues) || value.issues.length === 0) {
    contractError(`${path}.issues`, "必须包含至少一个主 issue");
  }
  value.issues.forEach((issue, index) => assertIssue(issue, `${path}.issues[${index}]`));
  const primary = value.issues[0] as Record<string, unknown>;
  const primaryPairs: Array<[string, unknown, unknown]> = [
    ["primaryState", value.primaryState, primary.state],
    ["primaryReasonCode", value.primaryReasonCode, primary.code],
    ["primaryReasonLabel", value.primaryReasonLabel, primary.label],
    ["nextOwner", value.nextOwner, primary.owner],
    ["primaryAction", value.primaryAction, primary.action],
    ["primaryActionTargetId", value.primaryActionTargetId, primary.actionTargetId],
  ];
  for (const [key, actual, expected] of primaryPairs) {
    if (!Object.is(actual, expected)) contractError(`${path}.${key}`, `必须与 ${path}.issues[0] 一致`);
  }
  assertInteger(value.additionalIssueCount, `${path}.additionalIssueCount`);
  if (value.additionalIssueCount !== value.issues.filter((issue) => (issue as Record<string, unknown>).state !== "follow_up").length - 1) {
    contractError(`${path}.additionalIssueCount`, "必须等于进度事项数量 - 1，独立问题另计");
  }

  const counters = value.counters;
  assertRecord(counters, `${path}.counters`);
  assertExactKeys(counters, counterKeys, `${path}.counters`);
  counterKeys.forEach((key) => assertInteger(counters[key], `${path}.counters.${key}`));
  const expectedCounters = {
    actionableByMentor: value.issues.filter((issue) => (issue as Record<string, unknown>).state === "mentor").length,
    waitingForStudent: value.issues.filter((issue) => (issue as Record<string, unknown>).state === "student").length,
    blocked: value.issues.filter((issue) => (issue as Record<string, unknown>).state === "follow_up").length,
    overdue: value.issues.filter((issue) => ["MILESTONE_OVERDUE", "NEXT_ACTION_OVERDUE"].includes(String((issue as Record<string, unknown>).code))).length,
  };
  counterKeys.forEach((key) => {
    if (counters[key] !== expectedCounters[key]) {
      contractError(`${path}.counters.${key}`, "与 issues 中的事实数量不一致");
    }
  });

  assertNullableString(value.latestSubstantiveTitle, `${path}.latestSubstantiveTitle`);
  assertNullableString(value.latestSubstantiveAt, `${path}.latestSubstantiveAt`);
  assertNullableString(value.latestSubmittedAt, `${path}.latestSubmittedAt`);
  assertNullableString(value.nextAction, `${path}.nextAction`);
  assertNullableString(value.nextActionDueDate, `${path}.nextActionDueDate`);
  assertPosition(value.paperPosition, `${path}.paperPosition`);
  assertPosition(value.projectPosition, `${path}.projectPosition`);
  if (!Array.isArray(value.recentSubstantive) || value.recentSubstantive.length > 3) {
    contractError(`${path}.recentSubstantive`, "必须是最多三条的数组");
  }
  value.recentSubstantive.forEach((progress, index) => (
    assertRecentProgress(progress, `${path}.recentSubstantive[${index}]`)
  ));
}

function assertMonthlyDelivery(value: unknown, path: string) {
  assertRecord(value, path);
  const countKeys = ["total", "confirmed", "pending", "needsChanges", "candidates"] as const;
  assertExactKeys(value, ["month", "phase", ...countKeys], path);
  assertString(value.month, `${path}.month`, false);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month)) contractError(`${path}.month`, "必须是有效的 YYYY-MM 月份");
  countKeys.forEach((key) => assertInteger(value[key], `${path}.${key}`));
  const counts = { confirmed: Number(value.confirmed), pending: Number(value.pending), needsChanges: Number(value.needsChanges) };
  if (value.total !== counts.confirmed + counts.pending + counts.needsChanges) contractError(`${path}.total`, "必须等于已确认、待确认与待补充数量之和");
  if (value.phase !== monthlyDeliveryPhase(counts)) contractError(`${path}.phase`, "必须与提交记录状态一致");
}

export function mentorOverviewResponseJsonBytes(value: unknown) {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    contractError("$", "必须可序列化为 JSON");
  }
  if (json === undefined) contractError("$", "必须可序列化为 JSON 对象");
  return new TextEncoder().encode(json).byteLength;
}

export function assertMentorOverviewResponse(value: unknown): asserts value is MentorOverviewResponse {
  assertNoSensitiveFields(value);
  assertRecord(value, "$");
  assertExactKeys(value, topLevelKeys, "$");
  assertString(value.generatedAt, "$.generatedAt", false);
  if (!Number.isFinite(Date.parse(value.generatedAt))) contractError("$.generatedAt", "必须是有效时间");
  if (value.timezone !== "Asia/Shanghai") contractError("$.timezone", "必须是 Asia/Shanghai");
  assertInteger(value.total, "$.total");
  if (value.total > MENTOR_OVERVIEW_MAX_STUDENTS) {
    contractError("$.total", `不能超过 ${MENTOR_OVERVIEW_MAX_STUDENTS}`);
  }
  assertInteger(value.weeklySubstantiveStudentCount, "$.weeklySubstantiveStudentCount");
  if (value.weeklySubstantiveStudentCount > value.total) {
    contractError("$.weeklySubstantiveStudentCount", "不能超过 total");
  }

  const counts = value.counts;
  assertRecord(counts, "$.counts");
  assertExactKeys(counts, overviewStates, "$.counts");
  overviewStates.forEach((state) => assertInteger(counts[state], `$.counts.${state}`));
  if (!Array.isArray(value.students)) contractError("$.students", "必须是数组");
  if (value.students.length !== value.total) contractError("$.total", "必须等于 students.length");

  const studentIds = new Set<string>();
  const expectedCounts = Object.fromEntries(overviewStates.map((state) => [state, 0])) as Record<OverviewState, number>;
  value.students.forEach((student, index) => {
    const path = `$.students[${index}]`;
    assertStudent(student, path);
    const studentRecord = student as Record<string, unknown>;
    const studentId = studentRecord.studentId as string;
    if (studentIds.has(studentId)) contractError(`${path}.studentId`, "在同一响应中必须唯一");
    studentIds.add(studentId);
    expectedCounts[studentRecord.primaryState as OverviewState] += 1;
  });
  overviewStates.forEach((state) => {
    if (counts[state] !== expectedCounts[state]) {
      contractError(`$.counts.${state}`, "与 students 的互斥主状态计数不一致");
    }
  });
  const countTotal = overviewStates.reduce((sum, state) => sum + Number(counts[state]), 0);
  if (countTotal !== value.total) contractError("$.counts", "五类计数总和必须等于 total");

  const bytes = mentorOverviewResponseJsonBytes(value);
  if (bytes > MENTOR_OVERVIEW_MAX_JSON_BYTES) {
    contractError("$", `JSON 响应为 ${bytes} bytes，超过 250 KB 门禁`);
  }
}
