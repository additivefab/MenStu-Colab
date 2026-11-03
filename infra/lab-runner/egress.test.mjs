// Egress gate (D5, T17). Real filesystem objects in a temp dir; no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { LIMITS } from "../../lib/research-loop/contracts.ts";
import { classifyKind, decideRegularFile, evaluateEgress } from "./egress.mjs";
import { sha256, tempRoot } from "./test-support/fixtures.mjs";

const POLICY = {
  schema: "tanyan.egress/v1",
  allowedExtensions: [".json", ".csv", ".png", ".txt"],
  maxFileBytes: 1000,
  maxTotalBytes: 1500,
  allowImages: false,
  blockDatasetHashMatches: true,
};

function setupOut(t) {
  const root = tempRoot(t);
  const out = join(root, "out");
  mkdirSync(out);
  return { root, out };
}

async function gate(out, { policy = POLICY, datasetHashes = new Set(["f".repeat(64)]) } = {}) {
  const result = await evaluateEgress({ outDir: out, policy, datasetHashes, locatorPrefix: "lab://r/run_1/out" });
  return { ...result, byPath: Object.fromEntries(result.artifacts.map((artifact) => [artifact.relativePath, artifact])) };
}

test("allowlisted small files are published with real sha256 and locators", async (t) => {
  const { out } = setupOut(t);
  mkdirSync(join(out, "tables"));
  writeFileSync(join(out, "metrics.json"), "{}");
  writeFileSync(join(out, "tables", "r.csv"), "a,b\n");
  const { byPath, published } = await gate(out);
  assert.equal(byPath["metrics.json"].egressDecision, "published");
  assert.equal(byPath["metrics.json"].sha256, sha256("{}"));
  assert.equal(byPath["metrics.json"].sizeBytes, 2);
  assert.equal(byPath["tables/r.csv"].kind, "table");
  assert.equal(byPath["tables/r.csv"].labLocator, "lab://r/run_1/out/tables/r.csv");
  assert.deepEqual(published.map((file) => file.relativePath), ["metrics.json", "tables/r.csv"]);
});

test("symlinks (file and directory, inside or escaping) are rejected and never followed", async (t) => {
  const { root, out } = setupOut(t);
  writeFileSync(join(root, "secret.txt"), "outside");
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(join(root, "elsewhere", "x.txt"), "x");
  writeFileSync(join(out, "ok.txt"), "ok");
  symlinkSync(join(root, "secret.txt"), join(out, "escape.txt"));
  symlinkSync("../secret.txt", join(out, "relative-escape.txt"));
  symlinkSync("ok.txt", join(out, "inside-link.txt"));
  symlinkSync(join(root, "elsewhere"), join(out, "dirlink"));
  const { byPath, published } = await gate(out);
  for (const name of ["escape.txt", "relative-escape.txt", "inside-link.txt", "dirlink"]) {
    assert.equal(byPath[name].egressDecision, "rejected", name);
    assert.match(byPath[name].egressReason, /symbolic link/);
    assert.equal(byPath[name].sha256, "");
  }
  assert.ok(!Object.keys(byPath).some((path) => path.startsWith("dirlink/")), "directory link not traversed");
  assert.deepEqual(published.map((file) => file.relativePath), ["ok.txt"]);
});

test("special files (named pipe, socket) are rejected", async (t) => {
  const { out } = setupOut(t);
  execFileSync("mkfifo", [join(out, "pipe.txt")]);
  const server = createServer();
  await new Promise((resolve) => server.listen(join(out, "sock.json"), resolve));
  t.after(() => server.close());
  const { byPath } = await gate(out);
  assert.equal(byPath["pipe.txt"].egressDecision, "rejected");
  assert.match(byPath["pipe.txt"].egressReason, /named pipe/);
  assert.equal(byPath["sock.json"].egressDecision, "rejected");
  assert.match(byPath["sock.json"].egressReason, /socket/);
});

test("non-normalized names (backslash traversal, control chars, .git) are rejected", async (t) => {
  const { out } = setupOut(t);
  writeFileSync(join(out, "..\\..\\evil.json"), "{}");
  writeFileSync(join(out, "bad\nname.json"), "{}");
  mkdirSync(join(out, ".git"));
  writeFileSync(join(out, ".git", "config.txt"), "x");
  const { artifacts, published } = await gate(out);
  assert.equal(published.length, 0);
  assert.equal(artifacts.length, 3);
  for (const artifact of artifacts) {
    assert.equal(artifact.egressDecision, "rejected");
    assert.match(artifact.egressReason, /not a normalized relative path/);
    assert.ok(!/[\n\\]/.test(artifact.relativePath), "reported path is sanitized");
  }
});

test("images are held unless allowImages=true", async (t) => {
  const { out } = setupOut(t);
  writeFileSync(join(out, "plot.png"), "png-bytes");
  assert.equal((await gate(out)).byPath["plot.png"].egressDecision, "held");
  assert.match((await gate(out)).byPath["plot.png"].egressReason, /allowImages=false/);
  assert.equal((await gate(out, { policy: { ...POLICY, allowImages: true } })).byPath["plot.png"].egressDecision, "published");
});

test("extension not allowlisted, oversize file and total cap are held", async (t) => {
  const { out } = setupOut(t);
  writeFileSync(join(out, "a.json"), "x".repeat(800));
  writeFileSync(join(out, "b.json"), "y".repeat(800)); // would exceed maxTotalBytes 1500
  writeFileSync(join(out, "big.csv"), "z".repeat(1001)); // > maxFileBytes
  writeFileSync(join(out, "model.pt"), "weights");
  writeFileSync(join(out, "noext"), "n");
  const { byPath } = await gate(out);
  assert.equal(byPath["a.json"].egressDecision, "published");
  assert.equal(byPath["b.json"].egressDecision, "held");
  assert.match(byPath["b.json"].egressReason, /maxTotalBytes/);
  assert.equal(byPath["big.csv"].egressDecision, "held");
  assert.match(byPath["big.csv"].egressReason, /maxFileBytes/);
  assert.equal(byPath["model.pt"].egressDecision, "held");
  assert.equal(byPath["model.pt"].kind, "model");
  assert.equal(byPath["noext"].egressDecision, "held");
});

test("a copy of a dataset file is rejected even with an allowlisted extension", async (t) => {
  const { out } = setupOut(t);
  const raw = JSON.stringify({ patient: "raw record" });
  writeFileSync(join(out, "renamed.json"), raw);
  const { byPath, published } = await gate(out, { datasetHashes: new Set([sha256(raw)]) });
  assert.equal(byPath["renamed.json"].egressDecision, "rejected");
  assert.match(byPath["renamed.json"].egressReason, /dataset manifest/);
  assert.equal(published.length, 0);
});

test("hard links are held", async (t) => {
  const { root, out } = setupOut(t);
  writeFileSync(join(root, "original.json"), "{\"a\":1}");
  linkSync(join(root, "original.json"), join(out, "linked.json"));
  assert.equal((await gate(out)).byPath["linked.json"].egressDecision, "held");
});

test("files above LIMITS.maxPublishedArtifactBytes are never inlined", () => {
  const policy = { ...POLICY, maxFileBytes: 100_000_000, maxTotalBytes: 100_000_000 };
  const decision = decideRegularFile({ relativePath: "x.json", sizeBytes: LIMITS.maxPublishedArtifactBytes + 1, sha256: "0".repeat(64) }, policy, new Set(), 0);
  assert.equal(decision.decision, "held");
  assert.match(decision.reason, /maxPublishedArtifactBytes/);
});

test("artifact cap keeps published entries first", async (t) => {
  const { out } = setupOut(t);
  for (let index = 0; index < 5; index += 1) writeFileSync(join(out, `h${index}.bin`), String(index));
  writeFileSync(join(out, "z.json"), "{}");
  const result = await evaluateEgress({ outDir: out, policy: POLICY, datasetHashes: new Set(), locatorPrefix: "lab://r/x/out", maxArtifacts: 2 });
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.truncated, 4);
  assert.ok(result.artifacts.some((artifact) => artifact.relativePath === "z.json"));
});

test("kind classification by path and extension", () => {
  assert.equal(classifyKind("metrics.json"), "metrics");
  assert.equal(classifyKind("sub/metrics.json"), "other");
  assert.equal(classifyKind("figures/a.json"), "figure");
  assert.equal(classifyKind("plot.SVG"), "figure");
  assert.equal(classifyKind("logs/train.txt"), "log");
  assert.equal(classifyKind("run.log"), "log");
  assert.equal(classifyKind("ckpt.safetensors"), "model");
  assert.equal(classifyKind("res.parquet"), "table");
  assert.equal(classifyKind("notes.md"), "other");
});

test("policy must be tanyan.egress/v1", async (t) => {
  const { out } = setupOut(t);
  await assert.rejects(evaluateEgress({ outDir: out, policy: { schema: "x" }, datasetHashes: new Set(), locatorPrefix: "p" }), /egress policy/);
});
