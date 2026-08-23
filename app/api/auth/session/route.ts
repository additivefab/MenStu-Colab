import { getAppUser, isFeishuConfigured, publicAppUser } from "../../../../lib/feishu-auth";

const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request) {
  if (!isFeishuConfigured()) {
    return Response.json({ configured: false, user: null }, { status: 503, headers: privateHeaders });
  }
  const user = await getAppUser(request);
  if (!user) return Response.json({ configured: true, user: null }, { status: 401, headers: privateHeaders });
  return Response.json({ configured: true, user: publicAppUser(user) }, { headers: privateHeaders });
}
