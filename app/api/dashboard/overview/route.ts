import { ensureDatabase } from "../../../../lib/database";
import { requireAppUser } from "../../../../lib/feishu-auth";
import { loadMentorOverview } from "../../../../lib/dashboard-overview/query";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Vary": "Cookie, Authorization",
};

function privateResponse(response: Response) {
  const headers = new Headers(response.headers);
  Object.entries(privateHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth && auth.response) return privateResponse(auth.response);
    await ensureDatabase();
    const overview = await loadMentorOverview(auth.user);
    return Response.json(overview, { headers: privateHeaders });
  } catch {
    return Response.json(
      { error: "全组进度暂时无法读取，请稍后重试" },
      { status: 500, headers: privateHeaders },
    );
  }
}
