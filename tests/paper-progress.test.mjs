import assert from "node:assert/strict";
import test from "node:test";

import {
  isIsoDate,
  isPaperStage,
  isPaperType,
  paperDeadlineState,
  paperStageMeta,
} from "../lib/paper-progress.ts";

test("paper stages are closed and expose an explicit gate", () => {
  assert.equal(isPaperStage("internal_review"), true);
  assert.equal(isPaperStage("almost_done"), false);
  assert.match(paperStageMeta.revision.gate, /逐条修改/);
  assert.equal(isPaperType("期刊论文"), true);
  assert.equal(isPaperType("博客"), false);
});

test("paper dates reject normalized but impossible calendar dates", () => {
  assert.equal(isIsoDate("2026-02-28"), true);
  assert.equal(isIsoDate("2026-02-29"), false);
  assert.equal(isIsoDate("2024-02-29"), true);
  assert.equal(isIsoDate("2026-13-01"), false);
});

test("paper deadline state distinguishes upcoming and overdue work", () => {
  assert.deepEqual(
    paperDeadlineState("2026-08-25", new Date("2026-08-23T00:00:00+08:00")),
    { label: "2 天后", overdue: false, days: 2 },
  );
  assert.deepEqual(
    paperDeadlineState("2026-08-20", new Date("2026-08-23T00:00:00+08:00")),
    { label: "逾期 3 天", overdue: true, days: -3 },
  );
  assert.deepEqual(
    paperDeadlineState("2026-08-23", new Date("2026-08-23T18:30:00+08:00")),
    { label: "今天到期", overdue: false, days: 0 },
  );
});
