"use client";

// Polling for live loop cards (frontend plan F4/F5). Runs `poll` every
// `baseMs` while `active`, pauses while the page is hidden, and backs off
// (doubling up to `maxMs`) after failures. Each call gets an AbortSignal that
// is aborted when polling stops or the component unmounts.

import { useEffect, useRef } from "react";

export function usePolling(poll: (signal: AbortSignal) => Promise<unknown>, { active, baseMs, maxMs = baseMs * 8 }: {
  active: boolean;
  baseMs: number;
  maxMs?: number;
}) {
  const latest = useRef(poll);
  useEffect(() => { latest.current = poll; }, [poll]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let delay = baseMs;
    let timer: number | undefined;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, delay);
    };
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "hidden") return; // resumed by visibilitychange
      try {
        await latest.current(controller.signal);
        delay = baseMs;
      } catch {
        delay = Math.min(delay * 2, maxMs);
      }
      schedule();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") { delay = baseMs; window.clearTimeout(timer); void tick(); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
    };
  }, [active, baseMs, maxMs]);
}
