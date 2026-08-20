import { getAppUser, isFeishuConfigured } from "../../../../lib/feishu-auth";

export async function GET(request: Request) {
  if (!isFeishuConfigured()) {
    return Response.json({ configured: false, user: null }, { status: 503 });
  }
  const user = await getAppUser(request);
  if (!user) return Response.json({ configured: true, user: null }, { status: 401 });
  return Response.json({ configured: true, user });
}
