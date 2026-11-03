// Pure helpers for the result card's batch 4 additions (frontend plan FA2–FA4):
// baseline comparison rows, student interpretation fields and the progress
// draft hand-off. No React, no DOM; shapes come from the results contract.

import type { InterpretationInput, ProgressDraft, ResultInterpretationView } from "../../lib/research-loop/results-contract.ts";

export type MetricValues = { readonly [name: string]: number };

export type MetricComparisonRow = {
  name: string;
  current: number | null;
  baseline: number | null;
  /** current − baseline, rounded to the inputs' precision; null when either side is missing. */
  delta: number | null;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Decimal places needed to print `value` exactly (capped). */
function decimals(value: number) {
  const text = String(Math.abs(value));
  const exponent = text.match(/e([+-]\d+)$/u);
  const [mantissa] = text.split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  const places = exponent ? fraction - Number(exponent[1]) : fraction;
  return Math.min(Math.max(places, 0), 12);
}

/** Rows "指标 / 本次 / 基线 / 差值": the current run's metric order first, then
 * metrics only the baseline has. A metric missing on either side has no delta. */
export function buildMetricComparison(current: MetricValues | null | undefined, baseline: MetricValues | null | undefined): MetricComparisonRow[] {
  const names = [...Object.keys(current ?? {})];
  for (const name of Object.keys(baseline ?? {})) if (!names.includes(name)) names.push(name);
  return names.map((name) => {
    const a = current && finite(current[name]) ? current[name] : null;
    const b = baseline && finite(baseline[name]) ? baseline[name] : null;
    let delta: number | null = null;
    if (a !== null && b !== null) {
      const places = Math.max(decimals(a), decimals(b));
      delta = Number((a - b).toFixed(places));
      if (Object.is(delta, -0)) delta = 0;
    }
    return { name, current: a, baseline: b, delta };
  });
}

/** Metric cell text; missing values read "—". */
export function metricText(value: number | null) {
  return value === null ? "—" : String(value);
}

/** Neutral difference text with an explicit sign ("+0.02", "−0.013", "0");
 * never coloured or worded as better/worse (FA2). */
export function deltaText(delta: number | null) {
  if (delta === null) return "—";
  if (delta === 0) return "0";
  return delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`;
}

export const INTERPRETATION_FIELDS: readonly { key: keyof InterpretationInput; label: string; hint: string }[] = [
  { key: "whatItShows", label: "结果说明了什么", hint: "结合指标和产物，说明这次结果支持或不支持假设的哪一部分" },
  { key: "alternativeExplanations", label: "其他可能的解释", hint: "除了这次修改，还有什么可能造成同样的结果" },
  { key: "limitations", label: "限制与异常", hint: "数据、划分、随机性、资源等限制，以及运行中观察到的异常" },
  { key: "proposedNextStep", label: "建议的下一步", hint: "下一轮准备验证什么、怎样判断" },
];

export const INTERPRETATION_MAX_LENGTH = 4000;

export function emptyInterpretation(): InterpretationInput {
  return { whatItShows: "", alternativeExplanations: "", limitations: "", proposedNextStep: "" };
}

export function interpretationInput(view: ResultInterpretationView | null | undefined): InterpretationInput {
  if (!view) return emptyInterpretation();
  return {
    whatItShows: view.whatItShows,
    alternativeExplanations: view.alternativeExplanations,
    limitations: view.limitations,
    proposedNextStep: view.proposedNextStep,
  };
}

/** True when at least one field has content (a blank interpretation is not submitted). */
export function interpretationHasContent(input: InterpretationInput) {
  return INTERPRETATION_FIELDS.some(({ key }) => input[key].trim() !== "");
}

/** Number of saved versions. Accepts a count or a list (the contract names the
 * field only) and falls back to the latest version number. */
export function interpretationVersionCount(versions: unknown, latest: ResultInterpretationView | null | undefined) {
  if (typeof versions === "number" && Number.isFinite(versions)) return Math.max(versions, latest?.version ?? 0);
  if (Array.isArray(versions)) return Math.max(versions.length, latest?.version ?? 0);
  return latest?.version ?? 0;
}

/** sessionStorage key the student progress composer reads (later batch). */
export const progressDraftStorageKey = (runId: string) => `tanyan:progress-draft:${runId}`;

/** Student progress composer, opened on a project entry prefilled from the run. */
export const progressDraftHref = (runId: string) => `/?view=progress&compose=project&draftRun=${encodeURIComponent(runId)}`;

const sourceTypeText: Record<ProgressDraft["evidenceSources"][number]["sourceType"], string> = { url: "链接", git: "代码" };

/** Plain-text rendering of a draft for the staff copy button. */
export function progressDraftText(draft: ProgressDraft) {
  const lines = [`【${draft.kind}进展】${draft.title}`, "", "摘要：", draft.summary, "", "证据：", draft.evidence];
  if (draft.evidenceSources.length) {
    lines.push("", "证据来源：");
    for (const source of draft.evidenceSources) lines.push(`- ${source.label}（${sourceTypeText[source.sourceType] ?? source.sourceType}）：${source.ref}`);
  }
  return lines.join("\n");
}
