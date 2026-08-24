import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboard = await readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const startIndex = dashboard.indexOf(start);
  const endIndex = dashboard.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker: ${end}`);
  return dashboard.slice(startIndex, endIndex);
}

test("research paper selection is URL-backed and restores the selected paper", () => {
  const navigationType = sourceBetween("type StudentNavigationIntent", "const studentViewMeta");
  const hrefBuilder = sourceBetween("function studentNavigationHref", "function studentNavigationFromLocation");
  const hrefParser = sourceBetween("function studentNavigationFromLocation", "function studentScrollBehavior");
  const applyNavigation = sourceBetween("const applyStudentNavigation", "function navigateStudent");
  const researchView = sourceBetween('{view === "research"', '{view === "progress"');
  const researchTracks = sourceBetween("function StudentResearchTracks", "type StudentLibraryMode");

  assert.match(navigationType, /paperId\?: number/u);
  assert.match(hrefBuilder, /params\.set\("paper", String\(intent\.paperId\)\)/u);
  assert.match(hrefParser, /paperId: Number\.isInteger\(rawPaper\).*rawPaper > 0 \? rawPaper : undefined/u);
  assert.match(applyNavigation, /setResearchPaperId\(intent\.view === "research".*intent\.paperId \?\? null/u);
  assert.match(researchView, /onSelectPaper=\{\(paperId\) => navigateStudent\(\{ view: "research", researchTrack: "paper", paperId \}\)\}/u);
  assert.match(researchTracks, /const selectedPaperEntries = leadPaper \? paperEntries\.filter/u);
  assert.match(researchTracks, /const latestPaperEntry = selectedPaperEntries\[0\]/u);
  assert.doesNotMatch(researchTracks, /latestPaperEntry[^;]*\?\? paperEntries\[0\]/u);
  assert.doesNotMatch(researchTracks, /setSelectedPaperId/u);
});

test("guidance and meeting deep links retain exact IDs until async records mount", () => {
  const navigationType = sourceBetween("type StudentNavigationIntent", "const studentViewMeta");
  const hrefBuilder = sourceBetween("function studentNavigationHref", "function studentNavigationFromLocation");
  const hrefParser = sourceBetween("function studentNavigationFromLocation", "function studentScrollBehavior");
  const targetResolver = sourceBetween("function studentNavigationTargetId", "function studentNavigationFallbackTargetId");
  const navigationEffect = sourceBetween("  useEffect(() => {\n    if (!pendingNavigation", "  if (!student) return");
  const nextAction = sourceBetween("function StudentNextAction", "function formDataHasVerifiableEvidence");
  const meetingPanel = sourceBetween("function StudentMeetingRequests", "function StaffMeetingRequests");

  assert.match(navigationType, /guidanceId\?: number/u);
  assert.match(navigationType, /meetingId\?: number/u);
  assert.match(hrefBuilder, /params\.set\("guidance", String\(intent\.guidanceId\)\)/u);
  assert.match(hrefBuilder, /params\.set\("meeting", String\(intent\.meetingId\)\)/u);
  assert.match(hrefParser, /guidanceId: Number\.isInteger\(rawGuidance\).*rawGuidance > 0 \? rawGuidance : undefined/u);
  assert.match(hrefParser, /meetingId: Number\.isInteger\(rawMeeting\).*rawMeeting > 0 \? rawMeeting : undefined/u);
  assert.match(targetResolver, /`student-guidance-\$\{intent\.guidanceId\}`/u);
  assert.match(targetResolver, /`student-meeting-\$\{intent\.meetingId\}`/u);
  assert.match(navigationEffect, /if \(!target\) return false/u);
  assert.match(navigationEffect, /new MutationObserver/u);
  assert.match(navigationEffect, /observer\.observe\(root, \{ childList: true, subtree: true \}\)/u);
  assert.match(navigationEffect, /setPendingNavigation\(\(current\) => current === intent \? null : current\)/u);
  assert.ok(navigationEffect.indexOf("if (!target) return false") < navigationEffect.indexOf("setPendingNavigation"));
  assert.match(nextAction, /onMeeting\(focus\.kind === "waiting" \? focus\.targetId : undefined\)/u);
  assert.match(meetingPanel, /id=\{`student-meeting-\$\{item\.id\}`\} tabIndex=\{-1\}/u);
});
