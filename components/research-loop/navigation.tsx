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

import { createContext, useContext, useEffect, useRef } from "react";
import type { TaskSummary } from "./api";
import type { StageTarget } from "./stage-model";

/** Change request as known to the panel (registered by ChangeRequestCard). */
export type ChangeRequestRef = {
  taskId: string;
  /** Per-task number by creation order ("变更 #n"), null if not computable. */
  number: number | null;
  prNumber: number | null;
};

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
  // Optional additions (A3). Consumers must tolerate their absence.
  /** Summary of a task loaded in this panel (null if not loaded). */
  task?: (taskId: string) => TaskSummary | null;
  /** Number/PR of a change request whose card has been rendered in this panel. */
  changeRequestRef?: (changeRequestId: string) => ChangeRequestRef | null;
  /** Called by ChangeRequestCard so lineage and titles can name the change. */
  registerChangeRequest?: (item: { id: string; taskId: string; createdAt: string; prNumber: number | null }) => void;
  /** Leaf cards (attempt/change request/run) call this before acting on a
   * focus; true only for the first claim of a focus key, so a card that
   * remounts later does not re-open or re-scroll for an old focus. */
  claimFocus?: (key: number) => boolean;
  /** runId → follow-up task created from that run's review (tasks whose
   * sourceRunId is the run), for the stage model's next stage. */
  followupTaskIdByRun?: Readonly<Record<string, string>>;
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

type LeafKind = "attempt" | "changeRequest" | "run";

function targetId(target: StageTarget): string {
  switch (target.kind) {
    case "task": return target.taskId;
    case "attempt": return target.attemptId;
    case "changeRequest": return target.changeRequestId;
    case "run": return target.runId;
  }
}

/** Opens a leaf card and scrolls it into view once per matching focus key.
 * Returns the ref to attach to the card root. */
export function useFocusedCard<T extends HTMLElement>(kind: LeafKind, id: string, setOpen: (open: boolean) => void) {
  const { focus, claimFocus } = useLoopNavigation();
  const ref = useRef<T>(null);
  const key = focus && focus.kind === kind && targetId(focus) === id ? focus.key : null;
  useEffect(() => {
    if (key === null) return;
    const timer = window.setTimeout(() => {
      if (claimFocus && !claimFocus(key)) return;
      setOpen(true);
      window.requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [key, claimFocus, setOpen]);
  return ref;
}
