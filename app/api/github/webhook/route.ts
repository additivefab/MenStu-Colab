import { ensureDatabase, getD1 } from "../../../../lib/database";
import { githubAppId, githubAppSlug, githubWebhookSecret } from "../../../../lib/github/tokens";
import { receiveGithubWebhook } from "../../../../lib/github/webhook";

// Public GitHub webhook endpoint: verifies the signature over the raw body
// before parsing, dedupes by X-GitHub-Delivery and only records state. It never
// runs repository content or enqueues compute work.
export async function POST(request: Request) {
  try {
    const secret = githubWebhookSecret();
    if (secret) await ensureDatabase();
    const result = await receiveGithubWebhook(getD1(), request, secret, { appId: githubAppId(), appSlug: githubAppSlug() });
    return Response.json(result.body, { status: result.httpStatus, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "事件处理失败" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
