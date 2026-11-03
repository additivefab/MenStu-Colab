import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildMetricComparison, deltaText, emptyInterpretation, INTERPRETATION_FIELDS, interpretationHasContent, interpretationInput,
  interpretationVersionCount, metricText, progressDraftHref, progressDraftStorageKey, progressDraftText,
} from "../components/research-loop/result-insights-model.ts";

// Synthetic fixtures typed after lib/research-loop/results-contract.ts.
const interpretation = (over = {}) => ({
  whatItShows: "注意力模块让 mIoU 提升约 1.8 个点",
  alternativeExplanations: "也可能来自训练轮数增加",
  limitations: "只跑了一个随机种子",
  proposedNextStep: "固定轮数，换三个种子复现",
  version: 2,
  authorUserId: 31,
  authorName: "测试学生",
  createdAt: "2026-11-03T08:00:00.000Z",
  ...over,
});

const draft = {
  kind: "项目",
  title: "运行 #3：注意力模块消融",
  summary: "注意力模块让 mIoU 提升约 1.8 个点",
  evidence: "运行 #3 · 执行提交 e4a0801 · metrics.json sha256 abcd",
  evidenceSources: [
    { sourceType: "url", label: "PR #12", ref: "https://github.com/lab/proj/pull/12" },
    { sourceType: "git", label: "执行提交", ref: "e4a0801" },
  ],
  from: { taskId: "task_1", runId: "run_3", changeRequestId: "cr_1", interpretationVersion: 2 },
};

test("metric comparison lists current metrics first, then baseline-only ones, with neutral signed deltas", () => {
  const rows = buildMetricComparison({ mIoU: 0.85, loss: 0.21, f1: 0.7 }, { mIoU: 0.8, loss: 0.25, recall: 0.6 });
  assert.deepEqual(rows.map((row) => row.name), ["mIoU", "loss", "f1", "recall"]);
  assert.deepEqual(rows[0], { name: "mIoU", current: 0.85, baseline: 0.8, delta: 0.05 });
  assert.equal(rows[1].delta, -0.04);
  assert.deepEqual(rows[2], { name: "f1", current: 0.7, baseline: null, delta: null });
  assert.deepEqual(rows[3], { name: "recall", current: null, baseline: 0.6, delta: null });
  assert.deepEqual(rows.map((row) => deltaText(row.delta)), ["+0.05", "−0.04", "—", "—"]);
  assert.deepEqual(rows.map((row) => [metricText(row.current), metricText(row.baseline)]), [["0.85", "0.8"], ["0.21", "0.25"], ["0.7", "—"], ["—", "0.6"]]);
});

test("metric comparison handles equal values, integers, tiny numbers and a baseline without metrics", () => {
  assert.equal(deltaText(buildMetricComparison({ a: 1 }, { a: 1 })[0].delta), "0");
  assert.equal(deltaText(buildMetricComparison({ a: 0.1 }, { a: 0.1 })[0].delta), "0");
  assert.equal(buildMetricComparison({ steps: 1200 }, { steps: 1000 })[0].delta, 200);
  assert.equal(buildMetricComparison({ lr: 3e-7 }, { lr: 1e-7 })[0].delta, 2e-7);
  assert.deepEqual(buildMetricComparison({ a: 0.5 }, null), [{ name: "a", current: 0.5, baseline: null, delta: null }]);
  assert.deepEqual(buildMetricComparison({ a: Number.NaN }, { a: 1 })[0], { name: "a", current: null, baseline: 1, delta: null });
  assert.deepEqual(buildMetricComparison(null, null), []);
});

test("interpretation helpers: four fields, content check and version count", () => {
  assert.deepEqual(INTERPRETATION_FIELDS.map((field) => field.label), ["结果说明了什么", "其他可能的解释", "限制与异常", "建议的下一步"]);
  assert.deepEqual(Object.keys(emptyInterpretation()).sort(), INTERPRETATION_FIELDS.map((field) => field.key).sort());
  assert.equal(interpretationHasContent(emptyInterpretation()), false);
  assert.equal(interpretationHasContent({ ...emptyInterpretation(), limitations: "  " }), false);
  assert.equal(interpretationHasContent({ ...emptyInterpretation(), limitations: "单种子" }), true);
  const input = interpretationInput(interpretation());
  assert.deepEqual(Object.keys(input).sort(), ["alternativeExplanations", "limitations", "proposedNextStep", "whatItShows"]);
  assert.deepEqual(interpretationInput(null), emptyInterpretation());
  assert.equal(interpretationVersionCount(3, interpretation({ version: 3 })), 3);
  assert.equal(interpretationVersionCount([{}, {}], interpretation()), 2);
  assert.equal(interpretationVersionCount(undefined, interpretation({ version: 4 })), 4);
  assert.equal(interpretationVersionCount(undefined, null), 0);
});

test("progress draft hand-off uses the agreed storage key, composer URL and a readable copy", () => {
  assert.equal(progressDraftStorageKey("run_3"), "tanyan:progress-draft:run_3");
  assert.equal(progressDraftHref("run_3"), "/?view=progress&compose=project&draftRun=run_3");
  const text = progressDraftText(draft);
  assert.match(text, /^【项目进展】运行 #3：注意力模块消融/u);
  assert.match(text, /- PR #12（链接）：https:\/\/github\.com\/lab\/proj\/pull\/12/u);
  assert.match(text, /- 执行提交（代码）：e4a0801/u);
});

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [insights, runCard, api] = await Promise.all([
  read("components/research-loop/result-insights.tsx"),
  read("components/research-loop/run-card.tsx"),
  read("components/research-loop/api.ts"),
]);

test("result insights follow the contract and gate actions on server permissions", () => {
  assert.doesNotMatch(insights, /\.role\b|superadmin|canReviewStudent|canViewStudent/u);
  assert.match(api, /from "\.\.\/\.\.\/lib\/research-loop\/results-contract\.ts"/u);
  for (const field of ["baseline", "baselineCandidates", "interpretation", "interpretationVersions", "canSetBaseline", "canInterpret", "canDraftProgress"]) {
    assert.match(api, new RegExp(`\\b${field}\\?:`, "u"), `RunDetail carries ${field}`);
  }
  assert.match(insights, /action: "set_baseline", runId: detail\.run\.id, baselineRunId/u);
  assert.match(insights, /permissions\.canSetBaseline === true/u);
  assert.match(insights, /action: "interpret", runId: detail\.run\.id, requestId, expectedVersion: interpretation\?\.version \?\? 0/u);
  assert.match(insights, /failure\.status === 409/u);
  assert.match(insights, /action: "progress_draft", runId: detail\.run\.id/u);
  assert.match(insights, /permissions\.canDraftProgress/u);
  assert.match(insights, /sessionStorage\.setItem\(progressDraftStorageKey/u);
  assert.match(insights, /进展须由学生本人提交/u);
});

test("baseline wording: protocol mismatch is never hidden and a missing baseline is stated", () => {
  assert.match(insights, /评价协议不同，不能作为同协议对比/u);
  assert.match(insights, /未设基线/u);
  for (const header of ["指标", "本次", "基线", "差值"]) assert.match(insights, new RegExp(`<th scope="col">${header}</th>`, "u"));
  // Differences are not coloured as good or bad.
  assert.doesNotMatch(insights, /tone=\{?["']?(good|bad)/u);
});

test("the student interpretation sits before the mentor review form", () => {
  assert.match(insights, /学生尚未解读，评审前可提醒学生补充/u);
  const section = runCard.indexOf("<InterpretationSection");
  const reviewForm = runCard.indexOf("<h4>评审结论</h4>");
  assert.ok(section > 0 && reviewForm > section, "interpretation renders before the review form");
  assert.ok(runCard.indexOf("<MetricsWithBaseline") < section, "evidence (with baseline) comes first");
});
