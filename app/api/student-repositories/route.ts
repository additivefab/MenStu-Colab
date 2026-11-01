import { canViewStudent } from "../../../lib/authorization";
import { getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import {
  changeStudentRepository, parseStudentRepositoryIdentity, parseStudentRepositoryInput,
  readStudentRepository, RepositoryConflictError, RepositoryInputError, unlinkStudentRepository,
} from "../../../lib/student-repository";

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function privateAuthResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function failure(error: unknown) {
  if (error instanceof RepositoryInputError) return json({ error: error.message }, 400);
  if (error instanceof RepositoryConflictError) return json({ error: error.message }, 409);
  return json({ error: "科研仓库设置暂时不可用，请稍后重试" }, 500);
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await request.json(); }
  catch { throw new RepositoryInputError("请求内容无效"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RepositoryInputError("请求内容无效");
  return body as Record<string, unknown>;
}

async function studentExists(studentId: string) {
  return getD1().prepare("SELECT id FROM students WHERE id = ? AND active = 1").bind(studentId).first();
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateAuthResponse(auth.response);
    const rawStudentId = new URL(request.url).searchParams.get("studentId");
    const { studentId } = parseStudentRepositoryIdentity({ studentId: rawStudentId, expectedVersion: 0 });
    if (!(await canViewStudent(auth.user, studentId))) return json({ error: "无权查看该学生的科研仓库" }, 403);
    if (!(await studentExists(studentId))) return json({ error: "学生不存在或已停用" }, 404);
    return json({ ...await readStudentRepository(getD1(), studentId), canManage: true });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    if (!assertSameOrigin(request)) return json({ error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateAuthResponse(auth.response);
    const input = parseStudentRepositoryInput(await bodyObject(request));
    if (!(await canViewStudent(auth.user, input.studentId))) return json({ error: "无权管理该学生的科研仓库" }, 403);
    if (!(await studentExists(input.studentId))) return json({ error: "学生不存在或已停用" }, 404);
    const state = await changeStudentRepository(getD1(), {
      studentId: input.studentId, actorUserId: auth.user.id,
      expectedVersion: input.expectedVersion, input,
    });
    return json({ ...state, canManage: true });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    if (!assertSameOrigin(request)) return json({ error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateAuthResponse(auth.response);
    const identity = parseStudentRepositoryIdentity(await bodyObject(request));
    if (!(await canViewStudent(auth.user, identity.studentId))) return json({ error: "无权管理该学生的科研仓库" }, 403);
    if (!(await studentExists(identity.studentId))) return json({ error: "学生不存在或已停用" }, 404);
    const state = await unlinkStudentRepository(getD1(), { ...identity, actorUserId: auth.user.id });
    return json({ ...state, canManage: true });
  } catch (error) { return failure(error); }
}
