const DEFAULT_UPSTREAM_URL =
  "https://progress.tz-ndt.com/api/feishu/events";
const MAX_BODY_BYTES = 1024 * 1024;
const FORWARDED_HEADERS = [
  "content-type",
  "x-lark-request-timestamp",
  "x-lark-request-nonce",
  "x-lark-signature",
];

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handleRequest(request, env = {}) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ status: "ok" }, 200);
  }

  if (request.method !== "POST" || url.pathname !== "/feishu/events") {
    return jsonResponse({ error: "not found" }, 404);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "json required" }, 415);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "body too large" }, 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "invalid body size" }, 413);
  }

  const headers = new Headers({ accept: "application/json" });
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const upstream = await fetch(env.UPSTREAM_URL || DEFAULT_UPSTREAM_URL, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "cache-control": "no-store",
        "content-type": upstream.headers.get("content-type") || "application/json",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return jsonResponse({ error: "upstream unavailable" }, 502);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
