import {
  assertSameOrigin,
  getAppUser,
  isAdminRole,
  personaCookie,
  type AppPersona,
} from "../../../../lib/feishu-auth";

const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) {
    return Response.json({ error: "请求来源无效" }, { status: 403, headers: privateHeaders });
  }

  const user = await getAppUser(request);
  if (!user) {
    return Response.json({ error: "请从飞书工作台打开并完成登录" }, { status: 401, headers: privateHeaders });
  }

  const body = await request.json().catch(() => ({})) as { persona?: string };
  const persona: AppPersona | null = body.persona === "management" || body.persona === "student"
    ? body.persona
    : null;
  if (!persona) {
    return Response.json({ error: "目标界面无效" }, { status: 400, headers: privateHeaders });
  }

  if (persona === "management" && !isAdminRole(user.primaryRole)) {
    return Response.json({ error: "当前账号没有管理端权限" }, { status: 403, headers: privateHeaders });
  }
  if (persona === "student" && !(user.studentId && (isAdminRole(user.primaryRole) || user.primaryRole === "student"))) {
    return Response.json({ error: "当前账号尚未绑定本人学生档案" }, { status: 403, headers: privateHeaders });
  }

  return Response.json(
    { message: persona === "student" ? "已切换到本人学生端" : "已切换到管理端", persona },
    { headers: { ...privateHeaders, "Set-Cookie": personaCookie(persona) } },
  );
}
