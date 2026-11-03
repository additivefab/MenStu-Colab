import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_ATTEMPT_TRANSITIONS, RUN_TRANSITIONS, canTransition, canonicalJson, evaluatePathPolicy,
  normalizeRepoPath, runSpecSha256, sha256Hex, validateMetricsFile,
} from "../lib/research-loop/contracts.ts";
import { parseTaskContent } from "../lib/research-loop/tasks-core.ts";

const spec = () => ({
  schema: "tanyan.runspec/v1", taskId: "task_a", taskVersion: 2, taskSnapshotSha256: "a".repeat(64), studentId: "s1",
  repository: { provider: "github", repositoryId: 42, fullName: "lab/study" },
  executedCommitSha: "1".repeat(40), changeRequestId: null,
  entrypoint: { id: "ep_1", argv: ["python", "train.py"], imageRef: "img@sha256:" + "b".repeat(64), params: { lr: 0.001, epochs: 3 } },
  dataset: { versionId: "ds_1", manifestSha256: "c".repeat(64), splitManifestSha256: "d".repeat(64), mount: "read_only" },
  evaluationProtocolSha256: "e".repeat(64),
  resources: { gpuCount: 1, walltimeMinutes: 30, memoryGb: 16 }, network: "deny",
  egress: { schema: "tanyan.egress/v1", allowedExtensions: [".json", ".png"], maxFileBytes: 1000, maxTotalBytes: 5000, allowImages: false, blockDatasetHashMatches: true },
});

test("canonical JSON is key-order independent and rejects lossy values", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), canonicalJson({ a: [true, null, "x"], b: 1 }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: Number.NaN }));
  assert.throws(() => canonicalJson({ a: new Date() }));
});

test("any run spec field change invalidates the approval hash (T09/T10)", async () => {
  const base = await runSpecSha256(spec());
  assert.match(base, /^[0-9a-f]{64}$/);
  const mutations = [
    (s) => { s.executedCommitSha = "2".repeat(40); },
    (s) => { s.dataset.manifestSha256 = "f".repeat(64); },
    (s) => { s.entrypoint.params.lr = 0.01; },
    (s) => { s.resources.gpuCount = 2; },
    (s) => { s.evaluationProtocolSha256 = "0".repeat(64); },
    (s) => { s.egress.allowImages = true; },
    (s) => { s.entrypoint.imageRef = "img@sha256:" + "9".repeat(64); },
  ];
  for (const mutate of mutations) {
    const changed = spec();
    mutate(changed);
    assert.notEqual(await runSpecSha256(changed), base);
  }
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("state machines have no exits from terminal states", () => {
  for (const terminal of ["completed", "failed", "canceled"]) assert.deepEqual(RUN_TRANSITIONS[terminal], []);
  assert.ok(canTransition(RUN_TRANSITIONS, "dispatching", "reconciling"));
  assert.ok(!canTransition(RUN_TRANSITIONS, "canceled", "queued"));
  assert.ok(!canTransition(AGENT_ATTEMPT_TRANSITIONS, "change_ready", "running"));
});

test("path policy normalizes paths and flags protected or out-of-scope changes", () => {
  for (const bad of ["/etc/passwd", "../x", "a/../b", "a//b", "a\\b", ".git/config", "src/.git/hooks/x", "C:/x"]) {
    assert.throws(() => normalizeRepoPath(bad), bad);
  }
  const result = evaluatePathPolicy(["src/model.py", ".github/workflows/ci.yml", "eval_protocol/metric.py", "docs/a.md"],
    ["src/**", "docs/*.md"], [".github/**", "eval_protocol/**"]);
  assert.deepEqual(result.outsideAllowed, [".github/workflows/ci.yml", "eval_protocol/metric.py"]);
  assert.deepEqual(result.protectedTouched, [".github/workflows/ci.yml", "eval_protocol/metric.py"]);
  assert.deepEqual(evaluatePathPolicy(["a/b/c.py"], [], []).outsideAllowed, []);
});

test("metrics must be machine-produced and well-formed (T19/T20)", () => {
  assert.equal(validateMetricsFile({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: "e".repeat(64), split: "test", values: { recall_small: 0.8 } }).ok, true);
  assert.equal(validateMetricsFile({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: "e".repeat(64), split: "test", values: { recall: "0.8" } }).ok, false);
  assert.equal(validateMetricsFile({ values: { recall: 0.8 } }).ok, false);
  assert.equal(validateMetricsFile({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: "e".repeat(64), split: "test", values: {} }).ok, false);
});

test("task content always keeps default protected paths", () => {
  const content = parseTaskContent({ title: "t", researchQuestion: "q", instructions: "i", acceptanceCriteria: "a", protectedPaths: ["configs/eval.yaml"] });
  assert.ok(content.protectedPaths.includes(".github/**"));
  assert.ok(content.protectedPaths.includes("configs/eval.yaml"));
  assert.throws(() => parseTaskContent({ title: "t", researchQuestion: "q", instructions: "i", acceptanceCriteria: "a", allowedPaths: ["../x"] }));
});
