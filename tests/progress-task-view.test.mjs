import assert from "node:assert/strict";
import test from "node:test";
import { groupProgressTasks, progressTaskFilter } from "../lib/progress-task-view.ts";

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
