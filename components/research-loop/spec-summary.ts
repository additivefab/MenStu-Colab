// Plain-language summary of a run spec for the approval decision (frontend
// plan F2, gate G3). Pure. CONTRACT (batch 2): B4 implements `describeRunSpec`;
// B3 renders it in run-card.tsx. The approval still binds the full spec hash.
//
// Pure and deterministic: no Date, no DOM, no locale-dependent sorting. Hashes
// never appear beyond a 7-character short SHA; full hashes, the image digest and
// the manifest hashes are shown in the "可追溯信息" section instead.
//
// Duration humanising (`durationLabel`):
//   < 60 min                    → "45 分钟"
//   whole days (n × 1440)       → "2 天"
//   whole hours                 → "2 小时"
//   whole half-hours            → "1.5 小时"
//   anything else ≥ 60 min      → "2 小时 15 分钟"
// Sizes use 1024-based units with at most one decimal, trailing ".0" dropped.

import { EGRESS_IMAGE_EXTENSIONS } from "../../lib/research-loop/contracts.ts";
import type { EgressPolicy, RunSpec, TaskBudget } from "./api";

export type SpecContext = {
  /** e.g. "PR #12" or "变更 #2"; null when the spec names a commit directly. */
  changeRequestLabel?: string | null;
  /** Human label of the dataset version, e.g. "合成数据 v1". */
  datasetLabel?: string | null;
  /** Registered entrypoint name. */
  entrypointName?: string | null;
  /** Budget of the confirmed task version the run belongs to. */
  taskBudget?: TaskBudget | null;
};

export type SpecSummary = {
  /** One sentence: which code, which data, what it runs, which resources. */
  sentence: string;
  /** What may leave the lab, in words (from the egress policy). */
  leavesLab: string;
  /** What stays in the lab, in words. */
  staysInLab: string;
  /** Resource request vs the task budget. */
  budget: { withinBudget: boolean; notes: string[] };
  /** Short labelled facts for a compact list (code, data, entrypoint, params, resources, network). */
  facts: { label: string; value: string }[];
};

const SHORT_SHA = 7;
const SENTENCE_PARAM_LIMIT = 4;
const PARAM_VALUE_LIMIT = 40;
const ARGV_LIMIT = 80;

/** Recognisable output groups, in display order. Images are handled separately. */
const EXTENSION_GROUPS: { name: string; extensions: string[] }[] = [
  { name: "指标", extensions: [".json", ".jsonl"] },
  { name: "表格", extensions: [".csv", ".tsv", ".xlsx", ".parquet"] },
  { name: "日志", extensions: [".log"] },
  { name: "文本", extensions: [".txt", ".md"] },
];

const MODEL_WEIGHT_EXTENSIONS = [".pt", ".pth", ".ckpt", ".safetensors", ".onnx", ".h5", ".pkl", ".bin", ".npz"];

export function describeRunSpec(spec: RunSpec, context: SpecContext = {}): SpecSummary {
  const sha = shortSha(spec.executedCommitSha);
  const crLabel = clean(context.changeRequestLabel);
  const datasetLabel = clean(context.datasetLabel);
  const entrypointName = clean(context.entrypointName);
  const params = sortedParams(spec.entrypoint.params);
  const argv = argvLabel(spec.entrypoint.argv);
  const { gpuCount, memoryGb, walltimeMinutes } = spec.resources;

  // Spaces only between CJK and Latin runs ("用 PR #12 的代码", "在数据集 ds_1 上").
  const code = crLabel ? `${spaced(crLabel)}的代码（${sha}）` : spec.changeRequestId ? `关联变更的代码（${sha}）` : `提交 ${sha} 的代码`;
  const data = datasetLabel ? `“${datasetLabel}”` : `数据集 ${spec.dataset.versionId} `;
  const target = entrypointName ? `入口“${entrypointName}”` : ` ${argv}`;
  const sentenceParams = params.length > SENTENCE_PARAM_LIMIT
    ? `${params.slice(0, SENTENCE_PARAM_LIMIT).join("，")} 等 ${params.length} 个参数`
    : params.join("，");
  const resources = `${gpuLabel(gpuCount)}、${number(memoryGb)} GB 内存，最长 ${durationLabel(walltimeMinutes)}`;
  const sentence = `用${code}在${data}上运行${target}${sentenceParams ? `（${sentenceParams}）` : ""}，${resources}。`;

  return {
    sentence,
    leavesLab: describeLeaves(spec.egress),
    staysInLab: describeStays(spec.egress),
    budget: compareBudget(spec.resources, context.taskBudget ?? null),
    facts: [
      { label: "代码", value: [crLabel, sha, spec.repository.fullName].filter(Boolean).join(" · ") },
      { label: "数据", value: `${datasetLabel ?? spec.dataset.versionId}（只读挂载）` },
      { label: "入口", value: entrypointName ? `${entrypointName} · ${argv}` : argv },
      { label: "参数", value: params.length ? params.join("，") : "无" },
      { label: "资源", value: `${gpuLabel(gpuCount)} · ${number(memoryGb)} GB 内存 · 最长 ${durationLabel(walltimeMinutes)}` },
      { label: "网络", value: spec.network === "deny" ? "禁止联网" : spec.network },
    ],
  };
}

/** Minutes in words; see the rules at the top of this file. */
export function durationLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  const total = Math.round(minutes);
  if (total < 60) return `${total} 分钟`;
  if (total % 1440 === 0) return `${total / 1440} 天`;
  if (total % 60 === 0) return `${total / 60} 小时`;
  if (total % 30 === 0) return `${total / 60} 小时`;
  return `${Math.floor(total / 60)} 小时 ${total % 60} 分钟`;
}

function describeLeaves(policy: EgressPolicy): string {
  const allowed = normalizeExtensions(policy.allowedExtensions);
  const images = allowed.filter((ext) => EGRESS_IMAGE_EXTENSIONS.includes(ext));
  const nonImages = allowed.filter((ext) => !EGRESS_IMAGE_EXTENSIONS.includes(ext));
  const imagesLeave = policy.allowImages && images.length > 0;

  const parts: string[] = [];
  const grouped = new Set<string>();
  for (const group of EXTENSION_GROUPS) {
    const hits = group.extensions.filter((ext) => nonImages.includes(ext));
    if (!hits.length) continue;
    hits.forEach((ext) => grouped.add(ext));
    parts.push(`${group.name}（${hits.join("/")}）`);
  }
  const others = nonImages.filter((ext) => !grouped.has(ext));
  if (others.length) parts.push(`其他（${others.join("/")}）`);
  if (imagesLeave) parts.push(`图片（${images.join("/")}）`);

  const clauses: string[] = [];
  if (parts.length) {
    clauses.push(`只有${parts.join("、")}文件可以离开实验室，单个文件不超过 ${bytes(policy.maxFileBytes)}、总计不超过 ${bytes(policy.maxTotalBytes)}`);
  } else {
    clauses.push("没有文件会离开实验室");
  }
  if (parts.length) clauses.push(imagesLeave ? "允许图片外发" : "图片不外发");
  clauses.push("与数据集文件内容相同的文件一律拦截");
  return `${clauses.join("；")}。`;
}

function describeStays(policy: EgressPolicy): string {
  const allowed = normalizeExtensions(policy.allowedExtensions);
  const imagesLeave = policy.allowImages && allowed.some((ext) => EGRESS_IMAGE_EXTENSIONS.includes(ext));
  const weightsLeave = allowed.some((ext) => MODEL_WEIGHT_EXTENSIONS.includes(ext));
  const held = [imagesLeave ? "" : "图片", weightsLeave ? "" : "模型权重", "其他文件"].filter(Boolean);
  const oversize = allowed.length ? "，超过大小上限的输出也留在实验室" : "";
  return `${held.join("、")}保留在实验室${oversize}；原始数据只读挂载，不会被拷出。`;
}

function compareBudget(resources: RunSpec["resources"], budget: TaskBudget | null): SpecSummary["budget"] {
  const maxGpu = finite(budget?.maxGpuCount);
  const maxWalltime = finite(budget?.maxWalltimeMinutes);
  if (maxGpu === null && maxWalltime === null) return { withinBudget: true, notes: ["任务未设上限"] };

  const notes: string[] = [];
  let withinBudget = true;
  if (maxGpu === null) {
    notes.push("任务未设 GPU 上限");
  } else if (resources.gpuCount > maxGpu) {
    withinBudget = false;
    notes.push(`申请 ${resources.gpuCount} 块 GPU，超过任务上限 ${maxGpu} 块`);
  } else {
    notes.push(`GPU：${resources.gpuCount === 0 ? "仅 CPU" : `${resources.gpuCount} 块`}，在任务上限 ${maxGpu} 块以内`);
  }
  if (maxWalltime === null) {
    notes.push("任务未设时长上限");
  } else if (resources.walltimeMinutes > maxWalltime) {
    withinBudget = false;
    notes.push(`最长 ${durationLabel(resources.walltimeMinutes)}，超过任务上限 ${durationLabel(maxWalltime)}`);
  } else {
    notes.push(`时长：最长 ${durationLabel(resources.walltimeMinutes)}，在任务上限 ${durationLabel(maxWalltime)}以内`);
  }
  if (!withinBudget) notes.push("超出任务预算的运行会被服务器拒绝，需先修改任务预算或降低资源申请");
  return { withinBudget, notes };
}

function sortedParams(params: Record<string, string | number | boolean>): string[] {
  return Object.keys(params)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${key}=${truncate(String(params[key]), PARAM_VALUE_LIMIT)}`);
}

function argvLabel(argv: string[]): string {
  if (!argv.length) return "（未登记命令）";
  const joined = argv.map((arg) => (/\s/.test(arg) || arg === "" ? JSON.stringify(arg) : arg)).join(" ");
  return truncate(joined, ARGV_LIMIT);
}

function normalizeExtensions(extensions: string[]): string[] {
  const unique = new Set<string>();
  for (const raw of extensions) {
    const ext = raw.trim().toLowerCase();
    if (!ext) continue;
    unique.add(ext.startsWith(".") ? ext : `.${ext}`);
  }
  return [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Pads a label with spaces where it meets CJK text on a Latin character. */
function spaced(value: string) {
  const start = /^[\x21-\x7e]/.test(value) ? " " : "";
  const end = /[\x21-\x7e]$/.test(value) ? " " : "";
  return `${start}${value}${end}`;
}

function gpuLabel(count: number) {
  return count > 0 ? `${count} 块 GPU` : "仅 CPU";
}

function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${number(Math.round(amount * 10) / 10)} ${units[unit]}`;
}

function number(value: number) {
  return Number.isFinite(value) ? String(value) : "—";
}

function shortSha(value: string) {
  return value ? value.slice(0, SHORT_SHA) : "—";
}

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function finite(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truncate(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
