import assert from "node:assert/strict";
import test from "node:test";
import { describeRunSpec, durationLabel } from "../components/research-loop/spec-summary.ts";

// Synthetic fixtures only; no real hashes, datasets or repositories.
const SHA = `e4a0801${"f".repeat(33)}`;
const MB = 1024 * 1024;

const egress = (over = {}) => ({
  schema: "tanyan.egress/v1",
  allowedExtensions: [".json", ".csv", ".log"],
  maxFileBytes: 10 * MB,
  maxTotalBytes: 50 * MB,
  allowImages: false,
  blockDatasetHashMatches: true,
  ...over,
});

const spec = (over = {}) => ({
  taskId: "task_1",
  taskVersion: 2,
  taskSnapshotSha256: "a".repeat(64),
  repository: { provider: "github", repositoryId: 7, fullName: "lab/proj" },
  executedCommitSha: SHA,
  changeRequestId: "cr_1",
  entrypoint: { id: "ep_1", argv: ["python", "scripts/train_eval.py"], imageRef: `img@sha256:${"b".repeat(64)}`, params: { epochs: 30 } },
  dataset: { versionId: "ds_synth_v1", manifestSha256: "c".repeat(64), splitManifestSha256: "d".repeat(64), mount: "read_only" },
  evaluationProtocolSha256: "9".repeat(64),
  resources: { gpuCount: 1, walltimeMinutes: 120, memoryGb: 16 },
  network: "deny",
  egress: egress(),
  ...over,
});

const fullContext = { changeRequestLabel: "PR #12", datasetLabel: "合成数据 v1", taskBudget: { maxGpuCount: 2, maxWalltimeMinutes: 240 } };
const fact = (summary, label) => summary.facts.find((item) => item.label === label)?.value;

const sentenceCases = [
  {
    name: "with context labels",
    spec: spec(),
    context: fullContext,
    sentence: "用 PR #12 的代码（e4a0801）在“合成数据 v1”上运行 python scripts/train_eval.py（epochs=30），1 块 GPU、16 GB 内存，最长 2 小时。",
  },
  {
    name: "without context falls back to short SHA, dataset id and argv",
    spec: spec({ changeRequestId: null }),
    context: undefined,
    sentence: "用提交 e4a0801 的代码在数据集 ds_synth_v1 上运行 python scripts/train_eval.py（epochs=30），1 块 GPU、16 GB 内存，最长 2 小时。",
  },
  {
    name: "change request without label",
    spec: spec(),
    context: {},
    sentence: "用关联变更的代码（e4a0801）在数据集 ds_synth_v1 上运行 python scripts/train_eval.py（epochs=30），1 块 GPU、16 GB 内存，最长 2 小时。",
  },
  {
    name: "CJK change label and entrypoint name",
    spec: spec(),
    context: { changeRequestLabel: "变更 #2", datasetLabel: "合成数据 v1", entrypointName: "训练评估" },
    sentence: "用变更 #2 的代码（e4a0801）在“合成数据 v1”上运行入口“训练评估”（epochs=30），1 块 GPU、16 GB 内存，最长 2 小时。",
  },
  {
    name: "CPU only, no params, 90 minutes",
    spec: spec({ entrypoint: { ...spec().entrypoint, params: {} }, resources: { gpuCount: 0, walltimeMinutes: 90, memoryGb: 8 } }),
    context: fullContext,
    sentence: "用 PR #12 的代码（e4a0801）在“合成数据 v1”上运行 python scripts/train_eval.py，仅 CPU、8 GB 内存，最长 1.5 小时。",
  },
  {
    name: "multi-GPU, long walltime",
    spec: spec({ resources: { gpuCount: 4, walltimeMinutes: 2880, memoryGb: 64 } }),
    context: fullContext,
    sentence: "用 PR #12 的代码（e4a0801）在“合成数据 v1”上运行 python scripts/train_eval.py（epochs=30），4 块 GPU、64 GB 内存，最长 2 天。",
  },
];

for (const item of sentenceCases) {
  test(`sentence: ${item.name}`, () => {
    assert.equal(describeRunSpec(item.spec, item.context).sentence, item.sentence);
  });
}

const durationCases = [
  [0, "0 分钟"], [45, "45 分钟"], [59, "59 分钟"], [60, "1 小时"], [90, "1.5 小时"], [120, "2 小时"],
  [135, "2 小时 15 分钟"], [150, "2.5 小时"], [1440, "1 天"], [2160, "36 小时"], [2880, "2 天"], [-1, "—"],
];
for (const [minutes, expected] of durationCases) {
  test(`durationLabel(${minutes}) = ${expected}`, () => assert.equal(durationLabel(minutes), expected));
}

test("params are sorted by key; the sentence shows four, facts show all", () => {
  const params = { zeta: 1, alpha: "a b", lr: 0.001, batch_size: 64, dropout: 0.1, use_amp: true };
  const summary = describeRunSpec(spec({ entrypoint: { ...spec().entrypoint, params } }), fullContext);
  assert.equal(fact(summary, "参数"), "alpha=a b，batch_size=64，dropout=0.1，lr=0.001，use_amp=true，zeta=1");
  assert.match(summary.sentence, /（alpha=a b，batch_size=64，dropout=0\.1，lr=0\.001 等 6 个参数）/);
});

test("egress without images: grouped extensions, caps, image and dataset clauses", () => {
  const summary = describeRunSpec(spec({ egress: egress({ allowedExtensions: [".log", ".CSV", "json", ".png", ".txt", ".npy"] }) }));
  assert.equal(summary.leavesLab,
    "只有指标（.json）、表格（.csv）、日志（.log）、文本（.txt）、其他（.npy）文件可以离开实验室，单个文件不超过 10 MB、总计不超过 50 MB；图片不外发；与数据集文件内容相同的文件一律拦截。");
  assert.equal(summary.staysInLab, "图片、模型权重、其他文件保留在实验室，超过大小上限的输出也留在实验室；原始数据只读挂载，不会被拷出。");
});

test("egress with images allowed lists the image formats", () => {
  const summary = describeRunSpec(spec({ egress: egress({ allowedExtensions: [".json", ".png", ".svg"], allowImages: true, maxFileBytes: 512 * 1024, maxTotalBytes: 1.5 * 1024 * MB }) }));
  assert.equal(summary.leavesLab,
    "只有指标（.json）、图片（.png/.svg）文件可以离开实验室，单个文件不超过 512 KB、总计不超过 1.5 GB；允许图片外发；与数据集文件内容相同的文件一律拦截。");
  assert.equal(summary.staysInLab, "模型权重、其他文件保留在实验室，超过大小上限的输出也留在实验室；原始数据只读挂载，不会被拷出。");
});

test("allowImages without any image extension still keeps images in", () => {
  const summary = describeRunSpec(spec({ egress: egress({ allowImages: true }) }));
  assert.match(summary.leavesLab, /；图片不外发；/);
  assert.match(summary.staysInLab, /^图片、/);
});

test("empty allowlist: nothing leaves, dataset clause still present", () => {
  const summary = describeRunSpec(spec({ egress: egress({ allowedExtensions: [] }) }));
  assert.equal(summary.leavesLab, "没有文件会离开实验室；与数据集文件内容相同的文件一律拦截。");
  assert.equal(summary.staysInLab, "图片、模型权重、其他文件保留在实验室；原始数据只读挂载，不会被拷出。");
});

const budgetCases = [
  {
    name: "within budget",
    resources: { gpuCount: 1, walltimeMinutes: 120, memoryGb: 16 },
    budget: { maxGpuCount: 2, maxWalltimeMinutes: 240 },
    within: true,
    notes: ["GPU：1 块，在任务上限 2 块以内", "时长：最长 2 小时，在任务上限 4 小时以内"],
  },
  {
    name: "CPU only within budget",
    resources: { gpuCount: 0, walltimeMinutes: 60, memoryGb: 4 },
    budget: { maxGpuCount: 1, maxWalltimeMinutes: 60 },
    within: true,
    notes: ["GPU：仅 CPU，在任务上限 1 块以内", "时长：最长 1 小时，在任务上限 1 小时以内"],
  },
  {
    name: "over GPU",
    resources: { gpuCount: 4, walltimeMinutes: 120, memoryGb: 16 },
    budget: { maxGpuCount: 2, maxWalltimeMinutes: 240 },
    within: false,
    notes: ["申请 4 块 GPU，超过任务上限 2 块", "时长：最长 2 小时，在任务上限 4 小时以内", "超出任务预算的运行会被服务器拒绝，需先修改任务预算或降低资源申请"],
  },
  {
    name: "over walltime",
    resources: { gpuCount: 1, walltimeMinutes: 300, memoryGb: 16 },
    budget: { maxGpuCount: 2, maxWalltimeMinutes: 240 },
    within: false,
    notes: ["GPU：1 块，在任务上限 2 块以内", "最长 5 小时，超过任务上限 4 小时", "超出任务预算的运行会被服务器拒绝，需先修改任务预算或降低资源申请"],
  },
  {
    name: "only a GPU cap",
    resources: { gpuCount: 1, walltimeMinutes: 120, memoryGb: 16 },
    budget: { maxGpuCount: 1, maxAgentMinutes: 30 },
    within: true,
    notes: ["GPU：1 块，在任务上限 1 块以内", "任务未设时长上限"],
  },
  { name: "empty budget object", resources: spec().resources, budget: {}, within: true, notes: ["任务未设上限"] },
  { name: "missing budget", resources: spec().resources, budget: null, within: true, notes: ["任务未设上限"] },
];

for (const item of budgetCases) {
  test(`budget: ${item.name}`, () => {
    const summary = describeRunSpec(spec({ resources: item.resources }), { taskBudget: item.budget });
    assert.deepEqual(summary.budget, { withinBudget: item.within, notes: item.notes });
  });
}

test("facts: labelled pairs in a fixed order", () => {
  const summary = describeRunSpec(spec(), { ...fullContext, entrypointName: "训练评估" });
  assert.deepEqual(summary.facts, [
    { label: "代码", value: "PR #12 · e4a0801 · lab/proj" },
    { label: "数据", value: "合成数据 v1（只读挂载）" },
    { label: "入口", value: "训练评估 · python scripts/train_eval.py" },
    { label: "参数", value: "epochs=30" },
    { label: "资源", value: "1 块 GPU · 16 GB 内存 · 最长 2 小时" },
    { label: "网络", value: "禁止联网" },
  ]);
});

test("no hash longer than 12 hex characters appears in sentence or facts", () => {
  for (const item of sentenceCases) {
    const summary = describeRunSpec(item.spec, item.context);
    const text = [summary.sentence, summary.leavesLab, summary.staysInLab, ...summary.facts.map((f) => f.value)].join("\n");
    assert.doesNotMatch(text, /[0-9a-f]{13,}/);
    assert.ok(!text.includes(SHA.slice(0, 8)));
  }
});

test("deterministic and does not mutate its input", () => {
  const input = spec({ entrypoint: { ...spec().entrypoint, params: { b: 2, a: 1 } } });
  const before = JSON.stringify(input);
  const first = describeRunSpec(input, fullContext);
  const second = describeRunSpec(structuredClone(input), structuredClone(fullContext));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
});
