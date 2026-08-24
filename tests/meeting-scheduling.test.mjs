import assert from "node:assert/strict";
import test from "node:test";

import { meetingIntervalsOverlap, shanghaiMeetingInterval } from "../lib/meeting-scheduling.ts";

test("meeting intervals reject overlap and allow adjacent slots", () => {
  const first = shanghaiMeetingInterval("2026-08-25", "10:00", 30);
  const overlapping = shanghaiMeetingInterval("2026-08-25", "10:15", 30);
  const adjacent = shanghaiMeetingInterval("2026-08-25", "10:30", 30);
  assert.equal(meetingIntervalsOverlap(first, overlapping), true);
  assert.equal(meetingIntervalsOverlap(first, adjacent), false);
});
