import assert from "node:assert/strict";
import test from "node:test";
import { comparisonBaseVersion, diffTaskVersions, splitProtectedPaths } from "../components/research-loop/version-diff-model.ts";
import { DEFAULT_PROTECTED_PATHS } from "../lib/research-loop/contracts.ts";

const version = (over = {}) => ({
  version: 1, title: "对比学习率", researchQuestion: "学习率对收敛有何影响？", hypothesis: "较小学习率更稳定",
  instructions: "在合成数据上训练两组", acceptanceCriteria: "给出两组曲线",
  allowedPaths: ["src/train/**", "configs/**"], protectedPaths: [...DEFAULT_PROTECTED_PATHS],
  budget: { maxAgentMinutes: 30, maxGpuCount: 1 },
  snapshotSha256: "a".repeat(64), authorUserId: 1, confirmedByUserId: null, confirmedAt: null, createdAt: "2026-11-03T08:00:00.000Z",
  ...over,
});

test("identical content yields no changes, ignoring metadata", () => {
  assert.deepEqual(diffTaskVersions(version(), version({ version: 2, snapshotSha256: "b".repeat(64), confirmedAt: "2026-11-03T09:00:00.000Z" })), []);
});

test("every text field is compared, in form order, with before and after", () => {
  const changes = diffTaskVersions(version(), version({
    title: "对比学习率 v2", researchQuestion: "新问题", hypothesis: "", instructions: "第一步\n第二步", acceptanceCriteria: "新标准",
  }));
  assert.deepEqual(changes.map((change) => change.field), ["title", "researchQuestion", "hypothesis", "instructions", "acceptanceCriteria"]);
  assert.ok(changes.every((change) => change.kind === "text"));
  assert.deepEqual(changes[2], { kind: "text", field: "hypothesis", label: "假设", before: "较小学习率更稳定", after: "" });
  assert.equal(changes[3].after, "第一步\n第二步");
});

test("line-ending differences alone are not a change", () => {
  assert.deepEqual(diffTaskVersions(version({ instructions: "a\r\nb" }), version({ instructions: "a\nb" })), []);
});

test("path lists report added and removed items and ignore order and duplicates", () => {
  assert.deepEqual(diffTaskVersions(version(), version({ allowedPaths: ["configs/**", "src/train/**", "configs/**"] })), []);
  const [change] = diffTaskVersions(version(), version({ allowedPaths: ["src/train/**", "src/models/**"] }));
  assert.equal(change.kind, "list");
  assert.equal(change.field, "allowedPaths");
  assert.deepEqual(change.added, ["src/models/**"]);
  assert.deepEqual(change.removed, ["configs/**"]);
  assert.deepEqual(change.before, ["src/train/**", "configs/**"]);
  assert.deepEqual(change.after, ["src/train/**", "src/models/**"]);
});

test("allowed paths going from the whole repository to a list are all additions", () => {
  const [change] = diffTaskVersions(version({ allowedPaths: [] }), version({ allowedPaths: ["src/**"] }));
  assert.deepEqual({ added: change.added, removed: change.removed, before: change.before }, { added: ["src/**"], removed: [], before: [] });
});

test("protected paths are diffed including defaults", () => {
  const changes = diffTaskVersions(version(), version({ protectedPaths: [...DEFAULT_PROTECTED_PATHS.filter((path) => path !== "AGENTS.md"), "baselines/**"] }));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "protectedPaths");
  assert.deepEqual(changes[0].added, ["baselines/**"]);
  assert.deepEqual(changes[0].removed, ["AGENTS.md"]);
});

test("budget is compared per key; unset differs from a number", () => {
  const [change] = diffTaskVersions(version(), version({ budget: { maxAgentMinutes: 45, maxWalltimeMinutes: 120 } }));
  assert.equal(change.kind, "budget");
  assert.deepEqual(change.items.map(({ key, before, after }) => ({ key, before, after })), [
    { key: "maxAgentMinutes", before: 30, after: 45 },
    { key: "maxGpuCount", before: 1, after: undefined },
    { key: "maxWalltimeMinutes", before: undefined, after: 120 },
  ]);
  assert.deepEqual(diffTaskVersions(version({ budget: { maxGpuCount: 0 } }), version({ budget: {} }))[0].items.map((item) => item.key), ["maxGpuCount"]);
  assert.deepEqual(diffTaskVersions(version({ budget: { maxGpuCount: 2 } }), version({ budget: { maxGpuCount: 2 } })), []);
});

test("all content fields together come out text, then lists, then budget", () => {
  const changes = diffTaskVersions(version(), version({
    title: "x", allowedPaths: ["src/**"], protectedPaths: [...DEFAULT_PROTECTED_PATHS, "data/raw/**"], budget: { maxGpuCount: 2 },
  }));
  assert.deepEqual(changes.map((change) => change.field), ["title", "allowedPaths", "protectedPaths", "budget"]);
});

test("comparison base: confirmed version for a revised draft, else the previous version", () => {
  assert.equal(comparisonBaseVersion({ status: "draft", currentVersion: 3, confirmedVersion: 2 }), 2);
  assert.equal(comparisonBaseVersion({ status: "draft", currentVersion: 3, confirmedVersion: 1 }), 1);
  assert.equal(comparisonBaseVersion({ status: "draft", currentVersion: 2, confirmedVersion: null }), 1);
  assert.equal(comparisonBaseVersion({ status: "draft", currentVersion: 1, confirmedVersion: null }), null);
  assert.equal(comparisonBaseVersion({ status: "confirmed", currentVersion: 2, confirmedVersion: 2 }), null);
  assert.equal(comparisonBaseVersion({ status: "closed", currentVersion: 3, confirmedVersion: 2 }), null);
});

test("protected paths split into defaults and task additions", () => {
  const split = splitProtectedPaths([...DEFAULT_PROTECTED_PATHS, "baselines/**", "baselines/**"], DEFAULT_PROTECTED_PATHS);
  assert.deepEqual(split.extra, ["baselines/**"]);
  assert.equal(split.defaults.length, DEFAULT_PROTECTED_PATHS.length);
  assert.deepEqual(splitProtectedPaths(["a/**"], DEFAULT_PROTECTED_PATHS), { defaults: [], extra: ["a/**"] });
});
