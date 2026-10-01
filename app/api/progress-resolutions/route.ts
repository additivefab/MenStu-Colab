import { canReviewStudent, canViewStudent, getStudentScope, scopeSql } from "../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import { acceptedTrackProgressSql } from "../../../lib/dashboard-overview/query-sql";
import { activeBlockerText } from "../../../lib/progress-blocker";
import { AttachmentInputError, attachmentStorageKey, validateProgressFiles } from "../../../lib/progress-attachments";
import { sha256Bytes, sha256Text } from "../../../lib/progress-evidence";
import { getProgressFileBucket } from "../../../lib/progress-file-storage";
import { deleteProgressFilesOrQueue } from "../../../lib/progress-file-cleanup";
import { loadCompletedProgressResolutionItems, loadCurrentResolutionSources, loadProgressResolutionItems, loadProgressResolutions } from "../../../lib/progress-resolution-service";
import { resolutionTransition, type ProgressResolutionCommand, type ProgressResolutionKind } from "../../../lib/progress-resolution";
import { insertResolutionSql, insertConfirmedResolutionSql, updateResolutionSql, insertResolutionEventSql, insertResolutionAuditSql,
  resolutionSourceGuardSql, resolutionStudentAuthoritySql, resolutionReviewerAuthoritySql,
  resolutionUploadGuardSql } from "../../../lib/progress-resolution-sql";

class InputError extends Error {}
const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const conflict = () => Response.json({ error: "事项已更新或已有后续进展，请刷新后查看；当前填写内容仍保留" }, { status: 409, headers: privateHeaders });
function clean(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > max) throw new InputError(`填写内容不能超过 ${max} 个字符`);
  return text;
}
function integer(value: unknown, minimum: number) {
  if (value === null || value === undefined || value === "" || (typeof value !== "string" && typeof value !== "number")) throw new InputError("事项参数无效");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new InputError("事项参数无效");
  return number;
}
function errorResponse(error: unknown) {
  return Response.json({ error: error instanceof InputError || error instanceof AttachmentInputError
    ? error.message : "处理结果保存失败，请稍后重试" }, {
    status: error instanceof InputError || error instanceof AttachmentInputError ? 400 : 500, headers: privateHeaders,
  });
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const url = new URL(request.url);
    const requestedStudentId = url.searchParams.get("studentId")?.trim() ?? "";
    if (url.searchParams.get("view") === "completed") {
      if (requestedStudentId && !(await canViewStudent(auth.user, requestedStudentId))) {
        return Response.json({ error: "无权查看该学生" }, { status: 403, headers: privateHeaders });
      }
      const studentScope = await getStudentScope(auth.user);
      // A requested student has already passed canViewStudent. Narrowing here
      // also keeps an exact-student query within D1's binding limit.
      if (requestedStudentId) {
        studentScope.studentIds = studentScope.all || studentScope.studentIds.includes(requestedStudentId) ? [requestedStudentId] : [];
        studentScope.all = false;
      }
      const scopes = studentScope.all || studentScope.studentIds.length <= 100 ? [studentScope] :
        Array.from({ length: Math.ceil(studentScope.studentIds.length / 100) }, (_, index) => ({
          all: false, studentIds: studentScope.studentIds.slice(index * 100, (index + 1) * 100),
        }));
      const students = (await Promise.all(scopes.map(async (part) => {
        const scope = scopeSql(part, "s.id");
        return (await getD1().prepare(`SELECT s.id FROM students s WHERE 1 = 1${scope.clause} ORDER BY s.id`)
          .bind(...scope.bindings).all<{ id: string }>()).results;
      }))).flat();
      const items = await loadCompletedProgressResolutionItems(students.map((student) => student.id));
      return Response.json({ items, canReview: false, canSubmit: false }, { headers: privateHeaders });
    }
    const studentId = auth.user.role === "student" ? auth.user.studentId ?? "" : requestedStudentId;
    if (!studentId) throw new InputError("缺少学生参数");
    if (auth.user.role === "student" && requestedStudentId && requestedStudentId !== studentId) {
      return Response.json({ error: "只能查看本人的处理事项" }, { status: 403 });
    }
    if (!(await canViewStudent(auth.user, studentId))) return Response.json({ error: "无权查看该学生" }, { status: 403 });
    const entryId = url.searchParams.has("entryId") ? integer(url.searchParams.get("entryId"), 1) : undefined;
    const [items, rows, canReview] = await Promise.all([
      loadProgressResolutionItems(studentId, entryId), loadProgressResolutions([studentId]), canReviewStudent(auth.user, studentId),
    ]);
    return Response.json({ items: items.map((item) => ({ ...item, canReview: canReview &&
      !rows.some((row) => row.progress_entry_id === item.progressEntryId && row.revision_number === item.revisionNumber &&
        row.item_kind === item.itemKind && row.submitted_by_user_id === auth.user.id) })),
      canReview, canSubmit: auth.user.role === "student" && auth.user.studentId === studentId }, { headers: privateHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

type PreparedFile = { fileName: string; contentType: string; bytes: ArrayBuffer; sizeBytes: number; contentSha256: string };
type StagedFile = PreparedFile & { storageKey: string; progressEntryId: null; studentId: string; revisionNumber: number };
async function stageFiles(files: PreparedFile[], studentId: string, entryId: number, revisionNumber: number) {
  const staged: StagedFile[] = [];
  try {
    for (const file of files) {
      const storageKey = attachmentStorageKey(studentId, entryId, file.fileName);
      // A parentless upload intent lets the existing janitor recover abandoned uploads
      // without ever claiming or deleting the already accepted progress entry.
      await getD1().prepare(`INSERT INTO progress_file_cleanup_queue
        (storage_key, progress_entry_id, student_id, revision_number, reason)
        VALUES (?, NULL, ?, ?, 'upload_intent')`).bind(storageKey, studentId, revisionNumber).run();
      staged.push({ ...file, storageKey, progressEntryId: null, studentId, revisionNumber });
      await getProgressFileBucket().put(storageKey, file.bytes, {
        httpMetadata: { contentType: file.contentType },
        customMetadata: { studentId, progressId: String(entryId), revisionNumber: String(revisionNumber), purpose: "resolution" },
      });
    }
    return staged;
  } catch (error) {
    await deleteProgressFilesOrQueue(staged, "resolution_upload_failed").catch(() => undefined);
    throw error;
  }
}
async function readReplay(userId: number, requestId: string, hash: string) {
  const row = await getD1().prepare(`SELECT request_hash FROM progress_resolution_events
    WHERE actor_user_id = ? AND request_id = ?`).bind(userId, requestId).first<{ request_hash: string }>();
  if (row && row.request_hash !== hash) throw new InputError("该请求已用于其他内容，请刷新后重新提交");
  return Boolean(row);
}
function resultMessage(action: ProgressResolutionCommand) {
  return action === "submit" ? "处理结果已提交，等待管理员确认" : action === "confirm" || action === "resolve" ? "已确认完成，该事项提醒已关闭" :
    action === "request_changes" ? "已退回，请学生补充处理结果" : "事项已重新打开，学生可以继续处理";
}
async function mutate(request: Request, isSubmission: boolean) {
  if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
  const auth = await requireAppUser(request, isSubmission ? ["student"] : ["superadmin", "admin"]);
  if ("response" in auth) return auth.response;
  await ensureDatabase();
  const form = isSubmission ? await request.formData() : null;
  const body = form ? null : await request.json() as Record<string, unknown>;
  const value = (key: string) => form ? form.get(key) : body?.[key];
  const entryId = integer(value("progressEntryId"), 1);
  const revisionNumber = integer(value("revisionNumber"), 1);
  const expectedVersion = integer(value("expectedVersion"), 0);
  const itemKind = clean(value("itemKind"), 20) as ProgressResolutionKind;
  if (!["blocker", "next_action"].includes(itemKind)) throw new InputError("事项类型无效");
  const action = isSubmission ? "submit" : clean(value("action"), 30) as ProgressResolutionCommand;
  if (!isSubmission && !["confirm", "resolve", "request_changes", "reopen"].includes(action)) throw new InputError("操作无效");
  const note = clean(value("note"), 4000);
  if (action !== "confirm" && !note) throw new InputError(action === "submit" ? "请说明处理结果" : action === "resolve" ? "请填写完成情况与核实依据" : "请填写具体原因");
  const requestId = clean(value("requestId"), 100);
  if (!/^[A-Za-z0-9_-]{16,100}$/u.test(requestId)) throw new InputError("缺少有效的请求标识，请刷新后重试");
  const parent = await getD1().prepare(`SELECT p.student_id FROM progress_entries p
    JOIN students s ON s.id = p.student_id AND s.active = 1
    WHERE p.id = ? AND NOT EXISTS (SELECT 1 FROM progress_deletions d WHERE d.progress_entry_id = p.id)`)
    .bind(entryId).first<{ student_id: string }>();
  if (!parent) return Response.json({ error: "进展不存在或已停用" }, { status: 404 });
  const studentId = parent.student_id;
  if (isSubmission ? auth.user.studentId !== studentId : !(await canReviewStudent(auth.user, studentId))) {
    return Response.json({ error: "当前账号无权处理此事项" }, { status: 403 });
  }
  const files = (form?.getAll("files") ?? []).filter((item): item is File => typeof item !== "string" && Boolean(item.name || item.size));
  const prepared = await Promise.all(validateProgressFiles(files).map(async ({ file, fileName, contentType }) => {
    const bytes = await file.arrayBuffer();
    return { fileName, contentType, bytes, sizeBytes: file.size, contentSha256: await sha256Bytes(bytes) };
  }));
  const hash = await sha256Text(JSON.stringify({ entryId, revisionNumber, itemKind, expectedVersion, action, note,
    files: prepared.map(({ fileName, contentType, sizeBytes, contentSha256 }) => ({ fileName, contentType, sizeBytes, contentSha256 })) }));
  if (await readReplay(auth.user.id, requestId, hash)) return Response.json({ message: resultMessage(action) }, { headers: privateHeaders });
  const [sources, rows] = await Promise.all([loadCurrentResolutionSources(studentId), loadProgressResolutions([studentId])]);
  const source = sources.find((row) => row.id === entryId && row.current_revision === revisionNumber);
  if (!source) return conflict();
  const text = itemKind === "blocker" ? activeBlockerText(source.blocker) : source.next_action.trim();
  if (!text) return conflict();
  const row = rows.find((item) => item.progress_entry_id === entryId && item.revision_number === revisionNumber && item.item_kind === itemKind);
  if ((row?.version ?? 0) !== expectedVersion || (!isSubmission && row?.submitted_by_user_id === auth.user.id)) return conflict();
  const fromStatus = row?.status ?? "open";
  const nextStatus = resolutionTransition(fromStatus, action);
  if (!nextStatus || (!row && !isSubmission && action !== "resolve")) return conflict();
  const staged = await stageFiles(prepared, studentId, entryId, revisionNumber);
  const sourceGuard = resolutionSourceGuardSql(acceptedTrackProgressSql(1));
  const authority = isSubmission ? resolutionStudentAuthoritySql : resolutionReviewerAuthoritySql;
  const guard = `${sourceGuard} AND ${authority} AND ${resolutionUploadGuardSql(staged.length)}`;
  const guardArgs = [studentId, entryId, revisionNumber, auth.user.id, studentId,
    ...(isSubmission ? [] : [studentId]), ...staged.map((file) => file.storageKey)];
  const d1 = getD1();
  const eventAction = action === "resolve" ? "confirm" : action;
  const mutation = !row ? d1.prepare(isSubmission ? insertResolutionSql(guard) : insertConfirmedResolutionSql(guard)).bind(studentId, entryId, revisionNumber,
    itemKind, source.title, text, itemKind === "next_action" ? source.next_action_due_date || null : null,
    source.track_type, note, ...(isSubmission ? [auth.user.id] : []), requestId, ...guardArgs) : d1.prepare(updateResolutionSql(guard))
    .bind(nextStatus, action, note, action, auth.user.id, action, action, note, nextStatus, requestId,
      entryId, revisionNumber, itemKind, expectedVersion, fromStatus, action, auth.user.id, ...guardArgs);
  const statements = [mutation,
    d1.prepare(insertResolutionEventSql).bind(auth.user.id, eventAction, fromStatus, note, requestId, hash,
      entryId, revisionNumber, itemKind, requestId, expectedVersion + 1),
    d1.prepare(insertResolutionAuditSql).bind(auth.user.id, requestId, requestId),
    ...staged.map((file) => d1.prepare(`INSERT INTO progress_resolution_attachments
      (event_id, storage_key, file_name, content_type, size_bytes, content_sha256)
      SELECT e.id, ?, ?, ?, ?, ? FROM progress_resolution_events e
      JOIN progress_resolutions pr ON pr.id = e.resolution_id
      WHERE e.actor_user_id = ? AND e.request_id = ? AND pr.last_request_id = ? AND pr.version = e.version`)
      .bind(file.storageKey, file.fileName, file.contentType, file.sizeBytes, file.contentSha256,
        auth.user.id, requestId, requestId)),
    ...staged.map((file) => d1.prepare(`DELETE FROM progress_file_cleanup_queue
      WHERE storage_key = ? AND EXISTS (SELECT 1 FROM progress_resolution_attachments a WHERE a.storage_key = ?)`)
      .bind(file.storageKey, file.storageKey)),
  ];
  try {
    const results = await d1.batch(statements);
    if (!results[0].meta.changes) {
      await deleteProgressFilesOrQueue(staged, "resolution_conflict").catch(() => undefined);
      if (await readReplay(auth.user.id, requestId, hash)) return Response.json({ message: resultMessage(action) }, { headers: privateHeaders });
      return conflict();
    }
  } catch (error) {
    // An interrupted D1 response can follow a committed transaction. Do not delete
    // uploaded objects here: the atomic batch removed intents only for saved files.
    // Remaining intents are recovered by the existing janitor after its lease expires.
    if (await readReplay(auth.user.id, requestId, hash)) return Response.json({ message: resultMessage(action) }, { headers: privateHeaders });
    throw error;
  }
  return Response.json({ message: resultMessage(action) }, { headers: privateHeaders });
}
export async function POST(request: Request) {
  try { return await mutate(request, true); } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request) {
  try { return await mutate(request, false); } catch (error) { return errorResponse(error); }
}
