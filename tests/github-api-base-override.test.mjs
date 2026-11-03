import assert from "node:assert/strict";
import nodeModule from "node:module";
import test from "node:test";

// lib/github/http.ts reads its Worker env through `cloudflare:workers`, which
// only exists inside workerd. A tiny resolve hook maps that specifier to a
// module whose `env` is a plain object this test controls.
const stub = "data:text/javascript,export const env = (globalThis.__githubOverrideTestEnv ??= {});";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve: (specifier, context, next) => (specifier === "cloudflare:workers" ? { url: stub, shortCircuit: true } : next(specifier, context)),
  });
} else {
  const hook = `export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(stub)}, shortCircuit: true };
  return next(specifier, context);
}`;
  nodeModule.register(`data:text/javascript,${encodeURIComponent(hook)}`);
}
const testEnv = (globalThis.__githubOverrideTestEnv ??= {});
const { GITHUB_API_BASE, GithubApiBaseOverrideError, githubRequest, resolveGithubApiBase } = await import("../lib/github/http.ts");

test("no override → api.github.com", () => {
  for (const value of [undefined, null, "", "   "]) assert.equal(resolveGithubApiBase(value), GITHUB_API_BASE);
  assert.equal(GITHUB_API_BASE, "https://api.github.com");
});

test("loopback http origins are accepted and normalised to the origin", () => {
  assert.equal(resolveGithubApiBase("http://127.0.0.1:4610"), "http://127.0.0.1:4610");
  assert.equal(resolveGithubApiBase("http://127.0.0.1:4610/"), "http://127.0.0.1:4610");
  assert.equal(resolveGithubApiBase(" http://localhost:4610 "), "http://localhost:4610");
  assert.equal(resolveGithubApiBase("http://LOCALHOST:9"), "http://localhost:9");
  assert.equal(resolveGithubApiBase("http://[::1]:4610"), "http://[::1]:4610");
  assert.equal(resolveGithubApiBase("http://127.0.0.1"), "http://127.0.0.1");
});

test("non-local hosts, other schemes and smuggling tricks are rejected", () => {
  const rejected = [
    "https://api.github.com",
    "http://api.github.com",
    "https://127.0.0.1:4610", // https is not needed locally; only plain http on loopback
    "http://evil.example",
    "http://localhost.evil.example",
    "http://127.0.0.1.nip.io",
    "http://localhost.",
    "http://10.0.0.5:4610",
    "http://192.168.1.10",
    "http://0.0.0.0:4610",
    "http://[::]:4610",
    "http://[::ffff:7f00:1]",
    "http://localhost@evil.example",
    "http://user:pass@127.0.0.1:4610",
    "http://evil.example#@127.0.0.1",
    "http://evil.example?@127.0.0.1",
    "http://127.0.0.1:4610/api/v3",
    "http://127.0.0.1:4610/?x=1",
    "http://127.0.0.1:4610/#frag",
    "file:///etc/passwd",
    "ws://127.0.0.1:4610",
    "javascript:alert(1)",
    "127.0.0.1:4610",
    "//127.0.0.1:4610",
    "not a url",
  ];
  for (const value of rejected) {
    assert.throws(() => resolveGithubApiBase(value), GithubApiBaseOverrideError, value);
  }
  for (const value of [42, true, {}, ["http://127.0.0.1"]]) {
    assert.throws(() => resolveGithubApiBase(value), GithubApiBaseOverrideError);
  }
});

test("githubRequest uses the env override and never contacts a rejected host", async (t) => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), authorization: init.headers.authorization });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; delete testEnv.GITHUB_API_BASE_URL; });

  delete testEnv.GITHUB_API_BASE_URL;
  await githubRequest("/app/installations", { bearer: "synthetic-jwt", context: "test" });
  assert.equal(seen.at(-1).url, "https://api.github.com/app/installations");

  testEnv.GITHUB_API_BASE_URL = "http://127.0.0.1:4610";
  await githubRequest("/repos/o/r", { bearer: "synthetic-jwt", context: "test" });
  assert.equal(seen.at(-1).url, "http://127.0.0.1:4610/repos/o/r");

  const before = seen.length;
  for (const value of ["https://evil.example", "http://evil.example", "http://localhost@evil.example"]) {
    testEnv.GITHUB_API_BASE_URL = value;
    await assert.rejects(githubRequest("/repos/o/r", { bearer: "synthetic-jwt", context: "test" }), GithubApiBaseOverrideError, value);
  }
  assert.equal(seen.length, before, "no request (and so no token) left the process for a rejected override");
});
