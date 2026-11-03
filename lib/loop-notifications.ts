import { headers } from "next/headers";
import { isFeishuConfigured, sendFeishuCard } from "./feishu-auth";
import { loopInboxHref } from "./research-loop-inbox";
import { VALID_DELEGATION_SQL } from "./review-delegation";

// FB3 (batch 5): research-loop notifications (docs/科研闭环_实施规格_v1.md §12).
// When a loop decision becomes someone's turn, that person gets one short
// Feishu card with a deep link. Rules:
// - Recipients follow lib/research-loop-inbox.ts and lib/review-delegation.ts;
//   the actor who caused the event is never notified. Only active, non-pending
//   users with a real Feishu open id (`ou_…`, never `local:…`) are recipients,
//   at most MAX_RECIPIENTS per event.
// - "Reviewing mentors" are active users with an active can_review assignment
//   for the student (canReviewStudent), never on their own student record; when
//   a student has no such mentor at all, active superadmins stand in.
// - Delivery is best effort, after the main commit: idempotent per event key +
//   recipient + channel (loop_notifications), `skipped` when Feishu is not
//   configured, `failed` (attempts + 1, short error) on errors, bounded by a
//   short timeout, and never throws into the caller.
// - Content is one Chinese line plus a link: no hashes, code, metric values,
//   file names or private notes.

export type LoopNotificationEvent =
  /** A draft task was created (task create or result follow-up). */
  | { kind: "task_draft"; taskId: string; actorUserId: number }
  /** A plan-first attempt submitted its plan (actor: the agent worker). */
  | { kind: "plan_submitted"; attemptId: string }
  /** A change request is waiting for review: on creation (actor: the agent
   * worker) or after its extra review was approved (actor: that mentor). */
  | { kind: "change_request"; changeRequestId: string; actorUserId: number | null }
  /** A run was created or rerun and waits for approval. */
  | { kind: "run_awaiting_approval"; runId: string; actorUserId: number }
  /** A run completed; its result waits for review (actor: the compute runner). */
  | { kind: "run_result_ready"; runId: string }
  /** A mentor saved a result review. */
  | { kind: "review_saved"; runId: string; version: number; actorUserId: number };

const CHANNEL = "feishu";
const MAX_RECIPIENTS = 20;
const SEND_TIMEOUT_MS = 3_000;
const TOTAL_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const FEISHU_OPEN_ID = /^ou_[A-Za-z0-9_-]{8,}$/;

type Plan = {
  eventKey: string;
  studentId: string;
  line: string;
  href: string;
  /** Candidate user ids before the recipient filter. */
  candidates: number[];
};

type Recipient = { id: number; feishu_open_id: string };

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError("发送超时")), ms);
  });
  // The losing promise may still settle later; never leave it unhandled.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function shortError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "未知错误").replace(/\s+/g, " ").slice(0, 200);
}

/** Task titles are free text: keep them short and drop anything hash-like. */
function safeTitle(title: string) {
  const printable = [...title].map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("");
  const clean = printable.replace(/[0-9a-fA-F]{32,}/g, "…").replace(/\s+/g, " ").trim();
  return [...clean].length > 40 ? `${[...clean].slice(0, 40).join("")}…` : clean;
}

function subject(studentName: string, title: string) {
  return `${safeTitle(studentName)} · 任务《${safeTitle(title)}》`;
}

const RUN_NUMBER = `(SELECT COUNT(*) FROM runs earlier WHERE earlier.task_id = r.task_id
  AND (earlier.created_at < r.created_at OR (earlier.created_at = r.created_at AND earlier.rowid <= r.rowid)))`;

const REVIEW_STATE_LABELS: Record<string, string> = { accepted: "已验收", rejected: "未通过", needs_followup: "需要跟进" };

async function studentUsers(d1: D1Database, studentId: string) {
  const { results } = await d1.prepare("SELECT id FROM app_users WHERE student_id = ? AND role = 'student' AND active = 1")
    .bind(studentId).all<{ id: number }>();
  return results.map((row) => Number(row.id));
}

/** Users who may make formal decisions for the student (canReviewStudent). */
async function reviewingMentors(d1: D1Database, studentId: string) {
  const { results } = await d1.prepare(`SELECT u.id FROM app_users u
      JOIN mentor_student_assignments a ON a.mentor_user_id = u.id
    WHERE a.student_id = ? AND a.active = 1 AND a.can_review = 1 AND u.active = 1
      AND u.role IN ('admin', 'mentor', 'superadmin') AND (u.student_id IS NULL OR u.student_id <> ?)`)
    .bind(studentId, studentId).all<{ id: number }>();
  if (results.length) return results.map((row) => Number(row.id));
  const fallback = await d1.prepare(`SELECT id FROM app_users WHERE role = 'superadmin' AND active = 1
      AND (student_id IS NULL OR student_id <> ?) ORDER BY id LIMIT ${MAX_RECIPIENTS}`)
    .bind(studentId).all<{ id: number }>();
  return fallback.results.map((row) => Number(row.id));
}

async function activeDelegates(d1: D1Database, studentId: string) {
  const { results } = await d1.prepare(`SELECT DISTINCT rd.reviewer_user_id AS id FROM review_delegations rd
    WHERE rd.student_id = ? AND ${VALID_DELEGATION_SQL}`).bind(studentId).all<{ id: number }>();
  return results.map((row) => Number(row.id));
}

const without = (ids: number[], excluded: (number | null | undefined)[]) =>
  ids.filter((id) => !excluded.some((value) => value !== null && value !== undefined && Number(value) === id));

/** Resolves one event into its key, line, link and candidate recipients, or
 * null when the object is no longer waiting (or its student is inactive). */
async function planFor(d1: D1Database, event: LoopNotificationEvent): Promise<Plan | null> {
  switch (event.kind) {
    case "task_draft": {
      const row = await d1.prepare(`SELECT t.id, t.student_id, t.title, t.current_version, s.display_name AS student_name
        FROM research_tasks t JOIN students s ON s.id = t.student_id
        WHERE t.id = ? AND t.status = 'draft' AND s.active = 1`).bind(event.taskId)
        .first<{ id: string; student_id: string; title: string; current_version: number; student_name: string }>();
      if (!row) return null;
      return {
        eventKey: `task_draft:${row.id}:v${Number(row.current_version)}`,
        studentId: row.student_id,
        line: `需要你确认：${subject(row.student_name, row.title)}（第 ${Number(row.current_version)} 版草稿）`,
        href: loopInboxHref(row.student_id, { taskId: row.id }),
        candidates: without(await studentUsers(d1, row.student_id), [event.actorUserId]),
      };
    }
    case "plan_submitted": {
      const row = await d1.prepare(`SELECT a.id, a.task_id, a.student_id, a.requested_by_user_id, p.version, t.title,
          s.display_name AS student_name
        FROM agent_attempts a JOIN agent_attempt_plans p ON p.attempt_id = a.id
          JOIN research_tasks t ON t.id = a.task_id JOIN students s ON s.id = a.student_id
        WHERE a.id = ? AND a.status = 'waiting_approval' AND p.decision = 'pending' AND s.active = 1`).bind(event.attemptId)
        .first<{ id: string; task_id: string; student_id: string; requested_by_user_id: number; version: number; title: string; student_name: string }>();
      if (!row) return null;
      const candidates = [...await studentUsers(d1, row.student_id), ...await reviewingMentors(d1, row.student_id)];
      return {
        eventKey: `plan_submitted:${row.id}:v${Number(row.version)}`,
        studentId: row.student_id,
        line: `需要你审阅代理计划：${subject(row.student_name, row.title)}`,
        href: loopInboxHref(row.student_id, { taskId: row.task_id }),
        // Nobody decides their own attempt's plan (decideAgentPlan).
        candidates: without(candidates, [row.requested_by_user_id]),
      };
    }
    case "change_request": {
      const row = await d1.prepare(`SELECT cr.id, cr.task_id, cr.student_id, cr.requires_extra_review, cr.extra_review_approved_at,
          a.requested_by_user_id, t.title, s.display_name AS student_name
        FROM change_requests cr JOIN agent_attempts a ON a.id = cr.attempt_id
          JOIN research_tasks t ON t.id = cr.task_id JOIN students s ON s.id = cr.student_id
        WHERE cr.id = ? AND cr.status IN ('pending_review', 'failed') AND s.active = 1`).bind(event.changeRequestId)
        .first<{ id: string; task_id: string; student_id: string; requires_extra_review: number; extra_review_approved_at: string | null;
          requested_by_user_id: number; title: string; student_name: string }>();
      if (!row) return null;
      const href = loopInboxHref(row.student_id, { taskId: row.task_id });
      const what = subject(row.student_name, row.title);
      if (Number(row.requires_extra_review) && !row.extra_review_approved_at) {
        // Extra review of protected paths: reviewing mentors, never the requester.
        return {
          eventKey: `change_extra_review:${row.id}`,
          studentId: row.student_id,
          line: `需要你额外审查：${what}的代码修改涉及受保护路径`,
          href,
          candidates: without(await reviewingMentors(d1, row.student_id), [row.requested_by_user_id, event.actorUserId]),
        };
      }
      // Ready to publish: the student; delegates only for non-protected changes
      // they did not request themselves (peer review rules).
      const delegates = Number(row.requires_extra_review)
        ? []
        : without(await activeDelegates(d1, row.student_id), [row.requested_by_user_id]);
      return {
        eventKey: `change_ready:${row.id}`,
        studentId: row.student_id,
        line: `需要你审查并发布代码修改：${what}`,
        href,
        candidates: without([...await studentUsers(d1, row.student_id), ...delegates], [event.actorUserId]),
      };
    }
    case "run_awaiting_approval":
    case "run_result_ready":
    case "review_saved": {
      const status = event.kind === "run_awaiting_approval" ? "awaiting_approval" : "completed";
      const row = await d1.prepare(`SELECT r.id, r.student_id, r.created_by_user_id, rs.created_by_user_id AS spec_created_by_user_id,
          t.title, s.display_name AS student_name, ${RUN_NUMBER} AS run_number, rv.state AS review_state
        FROM runs r JOIN research_tasks t ON t.id = r.task_id JOIN students s ON s.id = r.student_id
          JOIN run_specs rs ON rs.sha256 = r.run_spec_sha256 LEFT JOIN result_reviews rv ON rv.run_id = r.id
        WHERE r.id = ? AND r.status = ? AND s.active = 1`).bind(event.runId, status)
        .first<{ id: string; student_id: string; created_by_user_id: number; spec_created_by_user_id: number; title: string;
          student_name: string; run_number: number; review_state: string | null }>();
      if (!row) return null;
      const what = `${subject(row.student_name, row.title)}运行 #${Number(row.run_number)}`;
      const href = loopInboxHref(row.student_id, { runId: row.id });
      if (event.kind === "run_awaiting_approval") {
        return {
          eventKey: `run_awaiting_approval:${row.id}`,
          studentId: row.student_id,
          line: `需要你批准：${what}`,
          href,
          // Mirrors approveRun: neither the run's nor the spec's creator approves.
          candidates: without(await reviewingMentors(d1, row.student_id),
            [row.created_by_user_id, row.spec_created_by_user_id, event.actorUserId]),
        };
      }
      if (event.kind === "run_result_ready") {
        return {
          eventKey: `run_result_ready:${row.id}`,
          studentId: row.student_id,
          line: `运行已完成，结果待评审：${what}`,
          href,
          candidates: [...await studentUsers(d1, row.student_id), ...await reviewingMentors(d1, row.student_id)],
        };
      }
      const label = REVIEW_STATE_LABELS[row.review_state ?? ""];
      return {
        eventKey: `review_saved:${row.id}:v${Number(event.version)}`,
        studentId: row.student_id,
        line: `导师已评审运行结果：${what}${label ? `（结论：${label}）` : ""}`,
        href,
        candidates: without(await studentUsers(d1, row.student_id), [event.actorUserId]),
      };
    }
  }
}

/** Active, approved users with a real Feishu open id; at most MAX_RECIPIENTS. */
async function recipientsFor(d1: D1Database, candidates: number[]): Promise<Recipient[]> {
  const ids = [...new Set(candidates.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
  if (!ids.length) return [];
  const { results } = await d1.prepare(`SELECT id, feishu_open_id FROM app_users
    WHERE id IN (${ids.map(() => "?").join(",")}) AND active = 1 AND role <> 'pending' ORDER BY id`)
    .bind(...ids).all<Recipient>();
  return results.filter((row) => FEISHU_OPEN_ID.test(row.feishu_open_id)).slice(0, MAX_RECIPIENTS);
}

/** Feishu de-duplicates messages carrying the same uuid, so a send that timed
 * out here but reached Feishu is not delivered twice on a retry. */
async function messageUuid(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The site origin of the current request (route handlers only), or null. */
async function requestOrigin() {
  try {
    const requestHeaders = await headers();
    const host = requestHeaders.get("host")?.trim().toLowerCase() ?? "";
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || /\.localhost(:\d+)?$/.test(host);
    const forwarded = requestHeaders.get("x-forwarded-proto")?.trim().toLowerCase();
    const protocol = forwarded === "http" || forwarded === "https" ? forwarded : local ? "http" : "https";
    return `${protocol}://${host}`;
  } catch {
    return null;
  }
}

function card(line: string, url: string | null) {
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: "探研 · 科研闭环" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: line } },
      ...(url
        ? [{ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开查看" }, type: "primary", url }] }]
        : []),
    ],
  };
}

async function deliver(d1: D1Database, event: LoopNotificationEvent) {
  const plan = await planFor(d1, event);
  if (!plan) return;
  const recipients = await recipientsFor(d1, plan.candidates);
  if (!recipients.length) return;

  if (!isFeishuConfigured()) {
    await d1.batch(recipients.map((recipient) => d1.prepare(`INSERT INTO loop_notifications
        (event_key, recipient_user_id, channel, status, attempts) VALUES (?, ?, ?, 'skipped', 0)
        ON CONFLICT (event_key, recipient_user_id, channel) DO NOTHING`)
      .bind(plan.eventKey, recipient.id, CHANNEL)));
    return;
  }

  // Claim: a new row, or a failed one with attempts left. Rows that are sent,
  // skipped or being sent by a concurrent request return nothing.
  const claims = await d1.batch<{ recipient_user_id: number }>(recipients.map((recipient) => d1.prepare(`INSERT INTO loop_notifications
      (event_key, recipient_user_id, channel, status, attempts) VALUES (?, ?, ?, 'pending', 0)
      ON CONFLICT (event_key, recipient_user_id, channel) DO UPDATE SET status = 'pending'
        WHERE loop_notifications.status = 'failed' AND loop_notifications.attempts < ${MAX_ATTEMPTS}
      RETURNING recipient_user_id`)
    .bind(plan.eventKey, recipient.id, CHANNEL)));
  const claimed = recipients.filter((_, index) => claims[index]?.results?.length);
  if (!claimed.length) return;

  const origin = await requestOrigin();
  const url = origin ? new URL(plan.href, origin).toString() : null;
  const content = card(plan.line, url);
  const outcomes = await Promise.all(claimed.map(async (recipient) => {
    try {
      const uuid = await messageUuid(`loop-notification:${plan.eventKey}:${recipient.id}:${CHANNEL}`);
      await withTimeout(sendFeishuCard(recipient.feishu_open_id, content, uuid), SEND_TIMEOUT_MS);
      return { recipient, error: null };
    } catch (error) {
      return { recipient, error: shortError(error) };
    }
  }));
  await d1.batch(outcomes.map(({ recipient, error }) => (error === null
    ? d1.prepare(`UPDATE loop_notifications SET status = 'sent', attempts = attempts + 1, last_error = '', sent_at = CURRENT_TIMESTAMP
        WHERE event_key = ? AND recipient_user_id = ? AND channel = ? AND status = 'pending'`)
      .bind(plan.eventKey, recipient.id, CHANNEL)
    : d1.prepare(`UPDATE loop_notifications SET status = 'failed', attempts = attempts + 1, last_error = ?
        WHERE event_key = ? AND recipient_user_id = ? AND channel = ? AND status = 'pending'`)
      .bind(error, plan.eventKey, recipient.id, CHANNEL))));
  const failed = outcomes.filter((outcome) => outcome.error !== null).length;
  if (failed) console.warn(`loop notification ${event.kind}: ${failed} of ${outcomes.length} deliveries failed`);
}

/** Best-effort notification after a committed loop state change. Bounded by a
 * short timeout and never throws: the caller's response is unaffected. */
export async function notifyLoopEvent(d1: D1Database, event: LoopNotificationEvent): Promise<void> {
  try {
    await withTimeout(deliver(d1, event), TOTAL_TIMEOUT_MS);
  } catch (error) {
    console.warn(`loop notification ${event.kind} skipped: ${shortError(error)}`);
  }
}
