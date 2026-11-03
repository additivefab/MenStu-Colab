// Egress gate (D5, T17). Real filesystem objects in a temp dir; no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { LIMITS, validateAutoPublishPath } from "../../lib/research-loop/contracts.ts";
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

const PROTOCOL = "e".repeat(64);
const VALID_METRICS = JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: PROTOCOL, split: "test", values: { accuracy: 0.91 } }, null, 2);
/** Data-steward opt-in for the named paths (R03); everything else stays held. */
const optIn = (...paths) => ({ ...POLICY, autoPublishPaths: paths });

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

test("held by default: only a valid metrics.json is published; real sha256 and locators", async (t) => {
  const { out } = setupOut(t);
  mkdirSync(join(out, "tables"));
  writeFileSync(join(out, "metrics.json"), VALID_METRICS);
  writeFileSync(join(out, "tables", "r.csv"), "a,b\n");
  const { byPath, published } = await gate(out);
  assert.equal(byPath["metrics.json"].egressDecision, "published");
  assert.match(byPath["metrics.json"].egressReason, /可信指标/);
  assert.equal(byPath["metrics.json"].sha256, sha256(VALID_METRICS));
  assert.equal(byPath["metrics.json"].sizeBytes, Buffer.byteLength(VALID_METRICS));
  assert.equal(byPath["tables/r.csv"].kind, "table");
  assert.equal(byPath["tables/r.csv"].egressDecision, "held");
  assert.match(byPath["tables/r.csv"].egressReason, /需数据持有方授权后外发/);
  assert.equal(byPath["tables/r.csv"].labLocator, "lab://r/run_1/out/tables/r.csv");
  assert.deepEqual(published.map((file) => file.relativePath), ["metrics.json"]);
  const opted = await gate(out, { policy: optIn("tables/*.csv") });
  assert.equal(opted.byPath["tables/r.csv"].egressDecision, "published");
  assert.match(opted.byPath["tables/r.csv"].egressReason, /autoPublishPaths 命中 "tables\/\*\.csv"/);
  assert.deepEqual(opted.published.map((file) => file.relativePath), ["metrics.json", "tables/r.csv"]);
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
  // Opted in by name: a link is still rejected, never followed.
  const { byPath, published } = await gate(out, { policy: optIn("ok.txt", "escape.txt", "inside-link.txt") });
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
  assert.match((await gate(out, { policy: optIn("plot.png") })).byPath["plot.png"].egressReason, /allowImages=false/);
  assert.equal((await gate(out, { policy: { ...POLICY, allowImages: true } })).byPath["plot.png"].egressDecision, "held", "images need an opt-in too");
  assert.equal((await gate(out, { policy: { ...optIn("plot.png"), allowImages: true } })).byPath["plot.png"].egressDecision, "published");
});

test("extension not allowlisted, oversize file and total cap are held", async (t) => {
  const { out } = setupOut(t);
  writeFileSync(join(out, "a.json"), "x".repeat(800));
  writeFileSync(join(out, "b.json"), "y".repeat(800)); // would exceed maxTotalBytes 1500
  writeFileSync(join(out, "big.csv"), "z".repeat(1001)); // > maxFileBytes
  writeFileSync(join(out, "model.pt"), "weights");
  writeFileSync(join(out, "noext"), "n");
  const { byPath } = await gate(out, { policy: optIn("a.json", "b.json", "big.csv", "model.pt", "noext") });
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
  const decision = decideRegularFile({ relativePath: "x.json", sizeBytes: LIMITS.maxPublishedArtifactBytes + 1, sha256: "0".repeat(64) }, { ...policy, autoPublishPaths: ["x.json"] }, new Set(), 0);
  assert.equal(decision.decision, "held");
  assert.match(decision.reason, /maxPublishedArtifactBytes/);
});

test("artifact cap keeps published entries first", async (t) => {
  const { out } = setupOut(t);
  for (let index = 0; index < 5; index += 1) writeFileSync(join(out, `h${index}.bin`), String(index));
  writeFileSync(join(out, "z.json"), "{}");
  const result = await evaluateEgress({ outDir: out, policy: optIn("z.json"), datasetHashes: new Set(), locatorPrefix: "lab://r/x/out", maxArtifacts: 2 });
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

// ---------------------------------------------------------------------------
// R03: unauthorised copies are never auto-published (exit condition 2).
// Synthetic "dataset" bytes; each disguise is its own case. The policy allows
// every extension used, so only the held-by-default rule stands in the way.
// ---------------------------------------------------------------------------

const RAW = Buffer.from("id,age,diagnosis\n1,54,synthetic-condition-A\n2,61,synthetic-condition-B\n".repeat(4));
const WIDE = { ...POLICY, allowedExtensions: [".json", ".csv", ".log", ".txt", ".bin"], maxFileBytes: 100_000, maxTotalBytes: 200_000 };
const rawHashes = () => new Set([sha256(RAW)]);

async function assertNotPublished(out, names, { policy = WIDE } = {}) {
  const result = await gate(out, { policy, datasetHashes: rawHashes() });
  for (const name of names) {
    assert.notEqual(result.byPath[name].egressDecision, "published", name);
    assert.ok(!result.published.some((file) => file.relativePath === name), `${name} not uploaded`);
  }
  return result;
}

test("R03: base64- and hex-encoded copies of data are held", async (t) => {
  const { out } = setupOut(t);
  writeFileSync(join(out, "encoded.txt"), RAW.toString("base64"));
  writeFileSync(join(out, "encoded.json"), JSON.stringify({ blob: RAW.toString("hex") }));
  const { byPath } = await assertNotPublished(out, ["encoded.txt", "encoded.json"]);
  assert.equal(byPath["encoded.txt"].egressDecision, "held");
  assert.match(byPath["encoded.json"].egressReason, /需数据持有方授权后外发/);
});

test("R03: a copy split into chunks is held (no chunk matches a dataset hash)", async (t) => {
  const { out } = setupOut(t);
  mkdirSync(join(out, "parts"));
  const third = Math.ceil(RAW.length / 3);
  for (let index = 0; index < 3; index += 1) writeFileSync(join(out, "parts", `p${index}.csv`), RAW.subarray(index * third, (index + 1) * third));
  const { byPath } = await assertNotPublished(out, ["parts/p0.csv", "parts/p1.csv", "parts/p2.csv"]);
  for (const name of ["parts/p0.csv", "parts/p1.csv", "parts/p2.csv"]) assert.equal(byPath[name].egressDecision, "held");
});

test("R03: a binary renamed to .json is held; the exact raw bytes are still rejected", async (t) => {
  const { out } = setupOut(t);
  writeFileSync(join(out, "weights.json"), Buffer.from([0, 1, 2, 3, 255, 254, ...RAW.subarray(0, 64)]));
  writeFileSync(join(out, "copy.json"), RAW);
  const { byPath } = await assertNotPublished(out, ["weights.json", "copy.json"]);
  assert.equal(byPath["weights.json"].egressDecision, "held");
  assert.equal(byPath["copy.json"].egressDecision, "rejected", "defence in depth: exact copy rejected");
});

test("R03: a copy mixed into an otherwise valid log is held", async (t) => {
  const { out } = setupOut(t);
  mkdirSync(join(out, "logs"));
  writeFileSync(join(out, "logs", "job.log"), `epoch 1 loss 0.42\n${RAW.toString("utf8")}epoch 2 loss 0.31\n`);
  const { byPath } = await assertNotPublished(out, ["logs/job.log"]);
  assert.equal(byPath["logs/job.log"].egressDecision, "held");
  assert.equal(byPath["logs/job.log"].kind, "log");
});

test("R03: metrics.json with smuggled strings, nested blobs or padding is held", async (t) => {
  const base = { schema: "tanyan.metrics/v1", evaluationProtocolSha256: PROTOCOL, split: "test", values: { accuracy: 0.9 } };
  const cases = {
    "long split string": JSON.stringify({ ...base, split: RAW.toString("base64").slice(0, 60) + "=".repeat(40) }),
    "free-text split": JSON.stringify({ ...base, split: "id 1 age 54 diagnosis A" }),
    "extra nested blob": JSON.stringify({ ...base, extra: { rows: [RAW.toString("hex")] } }),
    "extra top-level field": JSON.stringify({ ...base, note: "x" }),
    "duplicate key hides a blob": `{"values":${JSON.stringify(RAW.toString("base64"))},${JSON.stringify(base).slice(1)}`,
    "padded numeric literals": JSON.stringify(base).replace("0.9", `0.9${"1234567890".repeat(40)}`),
    "whitespace padding": JSON.stringify(base) + " ".repeat(2000),
    "non-numeric value": JSON.stringify({ ...base, values: { accuracy: RAW.toString("base64") } }),
    "oversize file": JSON.stringify({ ...base, values: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`m_${"x".repeat(70)}_${index}`, index + 0.123456789])) }) + " ".repeat(20_000),
  };
  const policy = { ...WIDE, maxFileBytes: 100_000 };
  for (const [label, content] of Object.entries(cases)) {
    const { out } = setupOut(t);
    writeFileSync(join(out, "metrics.json"), content);
    const { byPath, published } = await gate(out, { policy, datasetHashes: rawHashes() });
    assert.equal(byPath["metrics.json"].egressDecision, "held", label);
    assert.match(byPath["metrics.json"].egressReason, /metrics\.json 未通过可信指标校验/, label);
    assert.equal(published.length, 0, label);
  }
});

test("R03: a valid metrics.json publishes (compact or indented, many values)", async (t) => {
  const many = { schema: "tanyan.metrics/v1", evaluationProtocolSha256: PROTOCOL, split: "val/fold-1",
    values: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`metric_${index}`, index / 7])) };
  for (const content of [VALID_METRICS, JSON.stringify(many), JSON.stringify(many, null, 4)]) {
    const { out } = setupOut(t);
    writeFileSync(join(out, "metrics.json"), content);
    const { byPath, published } = await gate(out, { policy: { ...WIDE, maxFileBytes: 100_000 } });
    assert.equal(byPath["metrics.json"].egressDecision, "published");
    assert.deepEqual(published.map((file) => file.relativePath), ["metrics.json"]);
  }
});

test("R03: only the exact top-level metrics.json is trusted", async (t) => {
  const { out } = setupOut(t);
  mkdirSync(join(out, "sub"));
  writeFileSync(join(out, "sub", "metrics.json"), VALID_METRICS);
  writeFileSync(join(out, "Metrics.json"), VALID_METRICS);
  const { byPath, published } = await gate(out);
  assert.equal(byPath["sub/metrics.json"].egressDecision, "held");
  assert.equal(byPath["Metrics.json"].egressDecision, "held");
  assert.equal(published.length, 0);
});

test("R03: an opt-in path publishes and records the policy basis; checks still apply", async (t) => {
  const { out } = setupOut(t);
  mkdirSync(join(out, "logs"));
  writeFileSync(join(out, "predictions.csv"), "id,prediction\n1,0\n");
  writeFileSync(join(out, "logs", "job.log"), "epoch 1 loss 0.4\n");
  writeFileSync(join(out, "logs", "copy.log"), RAW);
  writeFileSync(join(out, "logs", "big.log"), "x".repeat(100_001));
  writeFileSync(join(out, "other.csv"), "a\n");
  const policy = { ...WIDE, autoPublishPaths: ["predictions.csv", "logs/*.log"] };
  const { byPath, published } = await gate(out, { policy, datasetHashes: rawHashes() });
  assert.equal(byPath["predictions.csv"].egressDecision, "published");
  assert.match(byPath["predictions.csv"].egressReason, /数据持有方授权外发：autoPublishPaths 命中 "predictions\.csv"/);
  assert.equal(byPath["logs/job.log"].egressDecision, "published");
  assert.match(byPath["logs/job.log"].egressReason, /"logs\/\*\.log"/);
  assert.equal(byPath["logs/copy.log"].egressDecision, "rejected", "dataset-hash check survives an opt-in");
  assert.equal(byPath["logs/big.log"].egressDecision, "held", "size cap survives an opt-in");
  assert.match(byPath["logs/big.log"].egressReason, /maxFileBytes/);
  assert.equal(byPath["other.csv"].egressDecision, "held");
  assert.deepEqual(published.map((file) => file.relativePath).sort(), ["logs/job.log", "predictions.csv"]);
});

test("R03: autoPublishPaths accepts exact paths and narrow globs only", () => {
  for (const ok of ["predictions.csv", "logs/job.log", "logs/*.log", "tables/summary_*.csv"]) assert.equal(validateAutoPublishPath(ok).ok, true, ok);
  for (const bad of ["*.csv", "*", "logs/*", "logs/*.*", "**/*.log", "logs/**", "*/job.log", "logs/?.log", "../x.csv", "/abs.csv", "a b.csv", ""]) {
    assert.equal(validateAutoPublishPath(bad).ok, false, bad);
  }
});
