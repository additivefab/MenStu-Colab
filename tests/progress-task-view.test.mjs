import assert from "node:assert/strict";
import test from "node:test";
import { findProgressResolutionTarget, groupProgressTasks, parseProgressResolutionHash, progressTaskFilter } from "../lib/progress-task-view.ts";

const task = (key, status, current = true, resolvedAt = null) => ({ key, status, current, resolvedAt });

test("completed tasks remain visible after a later progress record replaces the source", () => {
  const historicalCompleted = task("completed-old", "resolved", false, "2026-09-19 08:00:00");
  const activeCompleted = task("completed-current", "resolved", true, "2026-09-20 08:00:00");
  const groups = groupProgressTasks([historicalCompleted, activeCompleted]);
  assert.deepEqual(groups.completed, [activeCompleted, historicalCompleted]);
  assert.deepEqual(groups.historical, []);
});

test("superseded open, pending and returned tasks never count as completed", () => {
  const historical = [task("old-open", "open", false), task("old-pending", "pending", false), task("old-returned", "changes_requested", false)];
  const groups = groupProgressTasks([...historical, task("active-open", "open"), task("active-returned", "changes_requested"), task("active-pending", "pending")]);
  assert.deepEqual(groups.historical, historical);
  assert.deepEqual(groups.completed, []);
  assert.deepEqual(groups.open.map((item) => item.key), ["active-open", "active-returned"]);
  assert.deepEqual(groups.pending.map((item) => item.key), ["active-pending"]);
});

test("reopening a confirmed task moves it back to pending work without counting past confirmation as completion", () => {
  assert.equal(progressTaskFilter(task("task", "resolved")), "completed");
  assert.equal(progressTaskFilter(task("task", "open")), "open");
  assert.equal(progressTaskFilter(task("task", "changes_requested")), "open");
  assert.equal(progressTaskFilter(task("task", "pending")), "pending");
});

test("completion order compares timezone-aware dates and keeps missing dates last without mutating input", () => {
  const items = [task("earlier", "resolved", true, "2026-09-20T09:00:00+08:00"), task("later", "resolved", false, "2026-09-20 02:00:00"), task("unknown", "resolved", false, "invalid")];
  assert.deepEqual(groupProgressTasks(items).completed.map((item) => item.key), ["later", "earlier", "unknown"]);
  assert.deepEqual(items.map((item) => item.key), ["earlier", "later", "unknown"]);
});

test("problem links retain their explicit revision and continue accepting existing current-task anchors", () => {
  assert.deepEqual(parseProgressResolutionHash("#progress-resolution-18-blocker-revision-2"), { progressEntryId: 18, itemKind: "blocker", revisionNumber: 2 });
  assert.deepEqual(parseProgressResolutionHash("progress-resolution-18-next_action"), { progressEntryId: 18, itemKind: "next_action" });
  for (const hash of ["progress-resolution-0-blocker", "progress-resolution-18-blocker-revision-0", "progress-resolution-18-blocker-revision-9007199254740992", "progress-resolution-9007199254740992-blocker", "progress-resolution-18-blocker&next=outside", "progress-18", "guidance-18"]) {
    assert.equal(parseProgressResolutionHash(hash), null, hash);
  }
});

test("an explicit historical problem link selects that revision instead of a newer problem", () => {
  const oldCompleted = { ...task("18:1:blocker", "resolved", false), progressEntryId: 18, revisionNumber: 1, itemKind: "blocker" };
  const oldUnresolved = { ...task("18:2:blocker", "changes_requested", false), progressEntryId: 18, revisionNumber: 2, itemKind: "blocker" };
  const current = { ...task("18:3:blocker", "open"), progressEntryId: 18, revisionNumber: 3, itemKind: "blocker" };
  const plan = { ...current, itemKind: "next_action", key: "18:3:next_action" };
  const unrelated = { ...current, progressEntryId: 19, key: "19:3:blocker" };
  const items = [plan, unrelated, current, oldCompleted, oldUnresolved];
  for (const item of [oldCompleted, oldUnresolved, current]) {
    const target = parseProgressResolutionHash(`progress-resolution-18-blocker-revision-${item.revisionNumber}`);
    assert.equal(findProgressResolutionTarget(items, target), item);
  }
  assert.equal(progressTaskFilter(findProgressResolutionTarget(items, { progressEntryId: 18, itemKind: "blocker", revisionNumber: 1 })), "completed");
  assert.equal(progressTaskFilter(findProgressResolutionTarget(items, { progressEntryId: 18, itemKind: "blocker", revisionNumber: 2 })), "historical");
  assert.equal(findProgressResolutionTarget(items, { progressEntryId: 18, itemKind: "blocker", revisionNumber: 4 }), undefined);
});

test("legacy problem links prefer the current item then the newest available historical revision", () => {
  const previous = { ...task("18:1:blocker", "resolved", false), progressEntryId: 18, revisionNumber: 1, itemKind: "blocker" };
  const latest = { ...previous, key: "18:2:blocker", revisionNumber: 2 };
  const current = { ...previous, key: "18:3:blocker", revisionNumber: 3, current: true };
  const target = { progressEntryId: 18, itemKind: "blocker" };
  const items = [previous, latest];
  assert.equal(findProgressResolutionTarget([...items, current], target), current);
  assert.equal(findProgressResolutionTarget(items, target), latest);
  assert.deepEqual(items, [previous, latest]);
  assert.equal(findProgressResolutionTarget(items, { ...target, progressEntryId: 19 }), undefined);
});
