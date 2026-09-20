import { getAppUser, isFeishuConfigured, publicAppUser } from "../../../../lib/feishu-auth";

const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request) {
  const user = await getAppUser(request);
  const methods = { configured: true, feishuConfigured: isFeishuConfigured(), localConfigured: true };
  if (!user) return Response.json({ ...methods, user: null }, { status: 401, headers: privateHeaders });
  return Response.json({ ...methods, user: publicAppUser(user) }, { headers: privateHeaders });
}
