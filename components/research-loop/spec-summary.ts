// Plain-language summary of a run spec for the approval decision (frontend
// plan F2, gate G3). Pure. CONTRACT (batch 2): B4 implements `describeRunSpec`;
// B3 renders it in run-card.tsx. The approval still binds the full spec hash.

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

/** Placeholder until B4 lands. */
export function describeRunSpec(spec: RunSpec, context: SpecContext = {}): SpecSummary {
  void context;
  return {
    sentence: `提交 ${spec.executedCommitSha.slice(0, 7)} · 数据集 ${spec.dataset.versionId}`,
    leavesLab: describeEgress(spec.egress),
    staysInLab: "",
    budget: { withinBudget: true, notes: [] },
    facts: [],
  };
}

function describeEgress(policy: EgressPolicy) {
  return policy.allowedExtensions.join(" ");
}
