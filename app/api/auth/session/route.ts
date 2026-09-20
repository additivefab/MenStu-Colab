import { getAppUser, isFeishuConfigured, publicAppUser } from "../../../../lib/feishu-auth";

const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request) {
  const user = await getAppUser(request, true);
  const methods = { configured: true, feishuConfigured: isFeishuConfigured(), localConfigured: true };
  if (!user) return Response.json({ ...methods, user: null }, { status: 401, headers: privateHeaders });
  if (user.mustChangePassword) return Response.json({ ...methods, user: null, code: "PASSWORD_CHANGE_REQUIRED" }, { status: 403, headers: privateHeaders });
  return Response.json({ ...methods, user: publicAppUser(user) }, { headers: privateHeaders });
}
