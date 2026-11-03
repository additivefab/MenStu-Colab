"use client";

// In-panel navigation between loop cards (frontend plan F3).
// CONTRACT (batch 1): A3 provides the real provider in research-loop-panel.tsx;
// A2 (task cards) and A3 (run/change/attempt cards) consume it.
//
// DOM anchors (stable; also usable as URL hashes on the student profile):
//   task           research-task-<taskId>
//   attempt        research-attempt-<attemptId>
//   change request research-cr-<changeRequestId>
//   run            research-run-<runId>
// Guidance notes on the student profile use #guidance-<noteId> (existing).

import { createContext, useContext } from "react";
import type { StageTarget } from "./stage-model";

export type LoopNavigation = {
  /** Last navigation request; cards matching it open and scroll into view. */
  focus: (StageTarget & { key: number }) | null;
  navigate: (target: StageTarget) => void;
  /** Title of a task in this panel, for lineage links (null if not loaded). */
  taskTitle: (taskId: string) => string | null;
  /** Task id + per-task number of a run in this panel (null if unknown). */
  runRef: (runId: string) => { taskId: string; number: number } | null;
  /** Link to a guidance note, or null where guidance notes are not on the page. */
  guidanceHref: (noteId: number) => string | null;
};

const noop: LoopNavigation = {
  focus: null,
  navigate: () => {},
  taskTitle: () => null,
  runRef: () => null,
  guidanceHref: () => null,
};

export const LoopNavigationContext = createContext<LoopNavigation>(noop);

export function useLoopNavigation() {
  return useContext(LoopNavigationContext);
}

export const anchorId = {
  task: (id: string) => `research-task-${id}`,
  attempt: (id: string) => `research-attempt-${id}`,
  changeRequest: (id: string) => `research-cr-${id}`,
  run: (id: string) => `research-run-${id}`,
};
