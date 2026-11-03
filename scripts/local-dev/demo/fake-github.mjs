// SIMULATED GitHub for the local demo loop (adapted from the stateful double in
// tests/research-loop-e2e.test.mjs). One HTTP server on 127.0.0.1 serves:
//   - the REST endpoints the platform's App client uses (App JWT checked
//     against the throwaway key, per-repository installation tokens, real
//     blobs/trees/commits/refs written into a local bare repository, PRs);
//   - git smart HTTP (git http-backend) for the agent worker and lab runner,
//     only for tokens it minted with contents access; pushes are refused;
//   - a small read-only PR viewer at / so the "PR" can be looked at in a browser.
// After it opens a PR it delivers a signed `pull_request` webhook to the
// platform, like GitHub would. Nothing here talks to the real GitHub.
import { spawn } from "node:child_process";
import { createHmac, randomUUID, verify } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { APP_ID, APP_SLUG, FIRST_PR_NUMBER, FULL_NAME, INSTALLATION_ID, ORG, REPO_ID, REPO_NAME, STATE_DIR, GITHUB_STATE_FILE } from "./constants.mjs";
import { git } from "./demo-repo.mjs";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);

function loadState() {
  try {
    const state = JSON.parse(readFileSync(GITHUB_STATE_FILE, "utf8"));
    return { pulls: Array.isArray(state.pulls) ? state.pulls : [], nextPrNumber: Number(state.nextPrNumber) || FIRST_PR_NUMBER };
  } catch { return { pulls: [], nextPrNumber: FIRST_PR_NUMBER }; }
}

/**
 * @param {{ port: number, publicKey: import("node:crypto").KeyObject, bare: string, githubRoot: string,
 *   platformUrl: string, webhookSecret: string, log: (line: string) => void }} options
 */
export async function startFakeGithub({ port, publicKey, bare, githubRoot, platformUrl, webhookSecret, log }) {
  const state = loadState();
  const save = () => writeFileSync(GITHUB_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  const tokens = new Map();
  const stats = { appCalls: 0, jwtRejected: 0, lastJwtError: null, gitFetches: 0 };
  let indexCounter = 0;
  const repository = { id: REPO_ID, full_name: FULL_NAME, name: REPO_NAME, default_branch: "main", private: true };
  const installation = { id: INSTALLATION_ID, app_id: Number(APP_ID), account: { login: ORG, type: "Organization" }, repository_selection: "selected", suspended_at: null };

  const objectType = (sha) => { try { return git(bare, ["cat-file", "-t", sha]); } catch { return null; } };
  const refSha = (branch) => { try { return git(bare, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]); } catch { return null; } };

  function jwtOk(auth) {
    const [h, p, s] = (auth?.replace(/^Bearer /, "") ?? "").split(".");
    try {
      if (!h || !p || !s) throw new Error("not a JWT");
      if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))) throw new Error("signature does not match the demo App key");
      const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
      if (payload.iss !== Number(APP_ID)) throw new Error("iss is not the demo App id");
      const now = Math.floor(Date.now() / 1000);
      if (!(payload.exp > now && payload.iat <= now + 60)) throw new Error("JWT outside its time window");
      stats.appCalls += 1;
      return true;
    } catch (error) {
      stats.jwtRejected += 1;
      stats.lastJwtError = error.message;
      return false;
    }
  }

  function prEvent(action, pull, sender) {
    return {
      action, number: pull.number, installation: { id: INSTALLATION_ID }, repository: { id: REPO_ID, full_name: FULL_NAME },
      sender,
      pull_request: {
        number: pull.number, merged: Boolean(pull.merged_at), draft: pull.draft, body: pull.body,
        head: { ref: pull.head.ref, sha: refSha(pull.head.ref) },
      },
    };
  }

  async function deliverWebhook(event, payload) {
    const raw = JSON.stringify(payload);
    try {
      const response = await fetch(`${platformUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json", "x-github-event": event, "x-github-delivery": randomUUID(),
          "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`,
          "user-agent": "GitHub-Hookshot/fake-demo",
        },
        body: raw,
      });
      const body = await response.json().catch(() => ({}));
      log(`webhook ${event}.${payload.action} PR #${payload.number} → HTTP ${response.status} ${body.status ?? ""}${body.origin ? ` (${body.origin})` : ""}`);
    } catch (error) {
      log(`webhook ${event}.${payload.action} delivery failed: ${error.message}`);
    }
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : undefined;
  }

  async function handleApi(req, res, url) {
    const method = req.method;
    const rest0 = url.pathname;
    const body = method === "GET" ? undefined : await readBody(req);
    const auth = req.headers.authorization;
    const grant = tokens.get(auth?.replace(/^Bearer /, ""));

    if (method === "GET" && rest0 === "/app/installations") return jwtOk(auth) ? json(res, 200, [installation]) : json(res, 401, { message: "A JSON web token could not be decoded" });
    let match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(rest0);
    if (method === "POST" && match) {
      if (!jwtOk(auth)) return json(res, 401, { message: "A JSON web token could not be decoded" });
      if (Number(match[1]) !== INSTALLATION_ID) return json(res, 404, { message: "Not Found" });
      const ids = body?.repository_ids ?? (body?.repositories ?? []).map((name) => (name === REPO_NAME ? REPO_ID : null));
      if (ids.length !== 1 || ids[0] !== REPO_ID) return json(res, 422, { message: "repository not accessible" });
      const token = `ghs_demo${randomUUID().replaceAll("-", "")}`;
      tokens.set(token, { permissions: body?.permissions ?? {} });
      return json(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: body?.permissions, repositories: [repository] });
    }
    match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(rest0);
    if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== FULL_NAME.toLowerCase()) return json(res, 404, { message: "Not Found" });
    const rest = match[3] ?? "";
    if (method === "GET" && rest === "/installation") return jwtOk(auth) ? json(res, 200, installation) : json(res, 401, { message: "Bad credentials" });
    if (!grant) return json(res, 401, { message: "Bad credentials" });
    const area = rest.startsWith("/pulls") ? "pull_requests" : rest ? "contents" : null;
    if (area && method === "POST" && grant.permissions[area] !== "write") return json(res, 403, { message: "Resource not accessible by integration" });
    if (area && method === "GET" && !grant.permissions[area]) return json(res, 403, { message: "Resource not accessible by integration" });
    if (method === "GET" && rest === "") return json(res, 200, repository);

    if ((match = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)) && method === "GET") {
      if (objectType(match[1]) !== "commit") return json(res, 404, { message: "Not Found" });
      return json(res, 200, { sha: match[1], tree: { sha: git(bare, ["rev-parse", `${match[1]}^{tree}`]) } });
    }
    if ((match = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === "GET") {
      const branch = match[1].split("/").map(decodeURIComponent).join("/");
      const sha = refSha(branch);
      return sha ? json(res, 200, { ref: `refs/heads/${branch}`, object: { type: "commit", sha } }) : json(res, 404, { message: "Not Found" });
    }
    if (method === "POST" && rest === "/git/blobs") {
      if (body.encoding !== "base64") return json(res, 422, { message: "encoding must be base64" });
      return json(res, 201, { sha: git(bare, ["hash-object", "-w", "--stdin"], { input: Buffer.from(body.content, "base64") }) });
    }
    if (method === "POST" && rest === "/git/trees") {
      const index = path.join(STATE_DIR, `index-${process.pid}-${++indexCounter}`);
      const env = { GIT_INDEX_FILE: index };
      try {
        git(bare, ["read-tree", body.base_tree], { env });
        const lines = body.tree.map((entry) => {
          if (entry.sha === null) return `0 ${"0".repeat(40)}\t${entry.path}`;
          const sha = entry.content !== undefined ? git(bare, ["hash-object", "-w", "--stdin"], { input: Buffer.from(entry.content, "utf8") }) : entry.sha;
          return `${entry.mode} ${sha}\t${entry.path}`;
        });
        git(bare, ["update-index", "--index-info"], { env, input: Buffer.from(`${lines.join("\n")}\n`) });
        return json(res, 201, { sha: git(bare, ["write-tree"], { env }) });
      } finally { rmSync(index, { force: true }); }
    }
    if (method === "POST" && rest === "/git/commits") {
      const env = {
        GIT_AUTHOR_NAME: body.author.name, GIT_AUTHOR_EMAIL: body.author.email, GIT_AUTHOR_DATE: body.author.date,
        GIT_COMMITTER_NAME: body.committer.name, GIT_COMMITTER_EMAIL: body.committer.email, GIT_COMMITTER_DATE: body.committer.date,
      };
      const parents = body.parents.flatMap((parent) => ["-p", parent]);
      return json(res, 201, { sha: git(bare, ["commit-tree", body.tree, ...parents, "-F", "-"], { env, input: Buffer.from(body.message) }) });
    }
    if (method === "POST" && rest === "/git/refs") {
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      if (refSha(branch)) return json(res, 422, { message: "Reference already exists" });
      git(bare, ["update-ref", body.ref, body.sha]);
      log(`branch ${branch} created at ${body.sha.slice(0, 12)}`);
      return json(res, 201, { ref: body.ref, object: { type: "commit", sha: body.sha } });
    }
    const withHead = (pull) => ({ ...pull, head: { ...pull.head, sha: refSha(pull.head.ref) } });
    if (method === "GET" && rest === "/pulls") {
      const head = url.searchParams.get("head") ?? "";
      return json(res, 200, state.pulls.filter((pull) => `${ORG}:${pull.head.ref}` === head).map(withHead));
    }
    if (method === "POST" && rest === "/pulls") {
      if (state.pulls.some((pull) => pull.head.ref === body.head)) return json(res, 422, { message: "A pull request already exists" });
      const number = state.nextPrNumber++;
      const pull = {
        number, html_url: `https://github.com/${FULL_NAME}/pull/${number}`, state: "open", merged_at: null, draft: body.draft,
        title: body.title, body: body.body, maintainer_can_modify: body.maintainer_can_modify,
        head: { ref: body.head }, base: { ref: body.base }, created_at: new Date().toISOString(),
      };
      state.pulls.push(pull);
      save();
      log(`PR #${number} opened (draft=${Boolean(body.draft)}): ${body.title}`);
      // GitHub reports the PR the App opened; the sender is the App's bot.
      setTimeout(() => void deliverWebhook("pull_request", prEvent("opened", pull, { login: `${APP_SLUG}[bot]`, type: "Bot" })), 200);
      return json(res, 201, withHead(pull));
    }
    return json(res, 404, { message: "Not Found" });
  }

  function handleGit(req, res, url) {
    const header = req.headers.authorization ?? "";
    const basic = /^basic\s+(.+)$/i.exec(header)?.[1];
    const [user, token] = basic ? Buffer.from(basic, "base64").toString("utf8").split(":") : [];
    const grant = user === "x-access-token" ? tokens.get(token) : null;
    const service = url.searchParams.get("service") ?? url.pathname.split("/").pop();
    if (!grant || !grant.permissions.contents) {
      res.writeHead(401, { "www-authenticate": "Basic realm=\"fake-github\"" });
      res.end("unauthorized");
      return;
    }
    if (service === "git-receive-pack") {
      res.writeHead(403);
      res.end("push refused: only the platform publishes, through the API");
      return;
    }
    stats.gitFetches += 1;
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH, GIT_PROJECT_ROOT: githubRoot, GIT_HTTP_EXPORT_ALL: "1", GIT_CONFIG_NOSYSTEM: "1",
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] ?? "", HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: req.headers["git-protocol"] ?? "", REMOTE_USER: "x-access-token", REMOTE_ADDR: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    req.pipe(child.stdin);
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("close", () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf("\r\n\r\n");
      const head = output.subarray(0, split).toString("utf8").split("\r\n");
      let status = 200;
      const headers = {};
      for (const line of head) {
        const [name, ...value] = line.split(":");
        if (name.toLowerCase() === "status") status = Number.parseInt(value.join(":").trim(), 10);
        else if (name) headers[name] = value.join(":").trim();
      }
      res.writeHead(status, headers);
      res.end(output.subarray(split + 4));
    });
  }

  const page = (title, inner) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:14px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;margin:0 auto;max-width:960px;padding:16px;color:#1f2328;background:#fff}
.banner{background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:8px 12px;margin-bottom:16px}
pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:12px;overflow:auto;font-size:12px}
.add{color:#116329}.del{color:#82071e}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d0d7de;padding:6px;text-align:left}
button{padding:6px 12px}</style></head><body><div class="banner">本地 GitHub 替身（合成演示，仅本机 127.0.0.1）。这里不是真实 GitHub。</div>${inner}</body></html>`;

  function diffHtml(base, head) {
    let diff = "";
    try { diff = git(bare, ["diff", "--no-color", `${base}...${head}`]); } catch (error) { diff = `diff unavailable: ${error.message}`; }
    return diff.split("\n").map((line) => {
      const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
      return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
    }).join("\n");
  }

  async function handleViewer(req, res, url) {
    const prPath = new RegExp(`^/${ORG}/${REPO_NAME}/pull/(\\d+)(/merge)?$`).exec(url.pathname);
    if (prPath) {
      const pull = state.pulls.find((item) => item.number === Number(prPath[1]));
      if (!pull) { res.writeHead(404); res.end("no such PR"); return; }
      if (prPath[2] && req.method === "POST") {
        // Demo merge: marks the PR merged and tells the platform; main is left
        // untouched so the same demo task can be run again.
        if (pull.state === "open") {
          pull.state = "closed";
          pull.merged_at = new Date().toISOString();
          save();
          log(`PR #${pull.number} marked merged (demo; main unchanged)`);
          await deliverWebhook("pull_request", prEvent("closed", pull, { login: "synthetic-mentor-human", type: "User" }));
        }
        res.writeHead(303, { location: `/${ORG}/${REPO_NAME}/pull/${pull.number}` });
        res.end();
        return;
      }
      const headSha = refSha(pull.head.ref) ?? "";
      const status = pull.merged_at ? "已合并（演示：main 未改动）" : pull.state === "open" ? (pull.draft ? "草稿 · 打开" : "打开") : "已关闭";
      const html = page(`PR #${pull.number}`, `<h1>#${pull.number} ${escapeHtml(pull.title)}</h1>
<p>状态：${escapeHtml(status)} · ${escapeHtml(pull.head.ref)} → ${escapeHtml(pull.base.ref)} · head <code>${escapeHtml(headSha.slice(0, 12))}</code></p>
<h2>说明</h2><pre>${escapeHtml(pull.body ?? "")}</pre>
<h2>改动</h2><pre>${diffHtml(pull.base.ref, pull.head.ref)}</pre>
${pull.state === "open" ? `<form method="post" action="/${ORG}/${REPO_NAME}/pull/${pull.number}/merge"><button type="submit">模拟合并（发送 pull_request.closed webhook）</button></form>` : ""}
<p><a href="/">全部 PR</a></p>`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (url.pathname === "/" && req.method === "GET") {
      const rows = state.pulls.slice().reverse().map((pull) => `<tr><td><a href="/${ORG}/${REPO_NAME}/pull/${pull.number}">#${pull.number}</a></td><td>${escapeHtml(pull.title)}</td><td>${pull.merged_at ? "已合并" : escapeHtml(pull.state)}</td><td><code>${escapeHtml(pull.head.ref)}</code></td></tr>`).join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(`${FULL_NAME} · PR`, `<h1>${escapeHtml(FULL_NAME)}</h1><p>main = <code>${escapeHtml((refSha("main") ?? "").slice(0, 12))}</code></p>
<table><thead><tr><th>PR</th><th>标题</th><th>状态</th><th>分支</th></tr></thead><tbody>${rows || "<tr><td colspan=4>还没有 PR</td></tr>"}</tbody></table>`));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = url.pathname.startsWith(`/${ORG}/${REPO_NAME}.git/`) ? handleGit
      : url.pathname.startsWith("/app/") || url.pathname.startsWith("/repos/") ? handleApi : handleViewer;
    Promise.resolve(route(req, res, url)).catch((error) => {
      log(`fake GitHub error on ${req.method} ${url.pathname}: ${error.message}`);
      if (!res.headersSent) json(res, 500, { message: "fake GitHub internal error" });
      else res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  if (!existsSync(GITHUB_STATE_FILE)) save();
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    pulls: state.pulls,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
