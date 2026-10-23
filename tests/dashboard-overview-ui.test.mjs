import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { overviewActionHref, overviewActionLabel } from "../components/dashboard-overview/overview-actions.ts";
import { earliestOverviewDueDate, overviewNextActionText, parseOverviewUrl, sortOverviewStudents } from "../components/dashboard-overview/overview-view-model.ts";

function student(overrides = {}) {
  return {
    studentId: "student-1",
    displayName: "学生甲",
    primaryState: "on_track",
    primaryAction: "view_student",
    primaryActionTargetId: null,
    issues: [],
    latestSubstantiveAt: "2026-08-20T00:00:00Z",
    ...overrides,
  };
}

test("overview URL state accepts only supported filters and remains recoverable", () => {
  assert.deepEqual(parseOverviewUrl("https://example.test/?view=overview&state=mentor&degree=phd&student=student-7"), {
    state: "mentor",
    degree: "phd",
    studentId: "student-7",
  });
  assert.deepEqual(parseOverviewUrl("https://example.test/?state=owner&degree=postdoc"), {
    state: "all",
    degree: "all",
    studentId: null,
  });
  assert.equal(parseOverviewUrl("https://example.test/?state=follow_up").state, "follow_up");
});

test("overview sorting is stable by state, earliest deadline, oldest trusted progress, then identity", () => {
  const issue = (dueDate) => [{ dueDate }];
  const rows = [
    student({ studentId: "d", displayName: "丁", primaryState: "student", issues: issue("2026-08-25") }),
    student({ studentId: "b", displayName: "乙", primaryState: "mentor", issues: issue("2026-08-27") }),
    student({ studentId: "a", displayName: "甲", primaryState: "intervene", issues: issue("2026-08-24") }),
    student({ studentId: "c", displayName: "丙", primaryState: "mentor", issues: issue("2026-08-26") }),
    student({ studentId: "g", displayName: "庚", primaryState: "follow_up", issues: issue(null) }),
    student({ studentId: "f", displayName: "己", primaryState: "on_track", latestSubstantiveAt: "2026-08-21T00:00:00Z" }),
    student({ studentId: "e", displayName: "戊", primaryState: "on_track", latestSubstantiveAt: null }),
  ];
  assert.deepEqual(rows.sort(sortOverviewStudents).map((row) => row.studentId), ["a", "c", "b", "g", "d", "e", "f"]);
});

test("earliest deadline is the minimum across all issues rather than the primary issue date", () => {
  const row = student({ issues: [{ dueDate: "2026-09-30" }, { dueDate: null }, { dueDate: "2026-08-20" }] });
  assert.equal(earliestOverviewDueDate(row), "2026-08-20");
});

test("next-action copy reflects resolution processing without asking for a duplicate plan", () => {
  assert.equal(overviewNextActionText(student({ primaryState: "mentor", primaryAction: "review_resolution", nextAction: null })), "处理结果待确认");
  assert.equal(overviewNextActionText(student({ primaryAction: "view_resolution", nextAction: null })), "处理结果待确认");
  assert.equal(overviewNextActionText(student({ primaryState: "student", primaryAction: "view_resolution", primaryReasonCode: "STUDENT_RESOLUTION_CHANGES_REQUESTED", nextAction: null })), "待补充处理结果");
  assert.equal(overviewNextActionText(student({ nextAction: null })), "暂无待办计划");
  assert.equal(overviewNextActionText(student({ primaryState: "insufficient", nextAction: null })), "等待补齐明确行动");
  assert.equal(overviewNextActionText(student({ primaryState: "mentor", primaryAction: "review_resolution", nextAction: "另一项仍待执行的计划" })), "另一项仍待执行的计划");
});

test("overview actions use a fixed route whitelist and reject an arbitrary proposal target", () => {
  const proposal = student({ primaryAction: "review_proposal", primaryActionTargetId: "27" });
  assert.equal(overviewActionLabel(proposal), "审核方案");
  assert.equal(overviewActionHref(proposal), "/?mentorView=research&researchTab=proposals&proposal=27");
  assert.equal(
    overviewActionHref(student({ primaryAction: "review_proposal", primaryActionTargetId: "27&next=https://evil.test" })),
    "/students/student-1#proposal",
  );
  assert.equal(
    overviewActionHref(student({ studentId: "../outside", primaryAction: "view_progress" })),
    "/students/..%2Foutside#evidence",
  );
  assert.equal(
    overviewActionHref(student({ primaryAction: "review_progress", primaryActionTargetId: 52 })),
    "/students/student-1#review-progress-52",
  );
  assert.equal(
    overviewActionHref(student({ primaryAction: "view_guidance", primaryActionTargetId: 19 })),
    "/students/student-1#guidance-19",
  );
  assert.equal(
    overviewActionHref(student({ primaryAction: "view_progress", primaryActionTargetId: 38 })),
    "/students/student-1#progress-38",
  );
  assert.equal(overviewActionLabel(student({ primaryAction: "complete_profile" })), "查看档案缺口");
  assert.equal(overviewActionLabel(student({ primaryAction: "view_progress", primaryReasonCode: "ON_TRACK_NEXT_ACTION" })), "查看进展");
  assert.equal(overviewActionLabel(student({ primaryAction: "view_progress", primaryReasonCode: "STUDENT_CHANGES_REQUESTED" })), "查看待补交");
  assert.equal(overviewActionHref(student({ primaryAction: "follow_up", primaryActionTargetId: "12&next=https://evil.test" })), "/students/student-1#outlook");
  assert.equal(overviewActionLabel(student({ primaryAction: "review_resolution" })), "确认处理结果");
  assert.equal(overviewActionLabel(student({ primaryAction: "view_resolution", primaryReasonCode: "STUDENT_RESOLUTION_CHANGES_REQUESTED" })), "查看待补充");
  assert.equal(overviewActionHref(student({ primaryAction: "review_resolution", primaryActionTargetId: 18 })), "/students/student-1#tasks-pending");
  assert.equal(overviewActionHref(student({ primaryAction: "view_resolution", primaryActionTargetId: "18&next=https://evil.test" })), "/students/student-1#tasks-pending");
});

test("overview UI keeps old views, accessible drawer, responsive cards, and read-only data flow", async () => {
  const [dashboard, overview, drawer, table, mobile, css, sessionRoute] = await Promise.all([
    readFile(new URL("../app/dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/dashboard-overview/mentor-group-overview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/dashboard-overview/student-overview-drawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/dashboard-overview/overview-table.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/dashboard-overview/overview-mobile-list.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/session/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /id: "overview", label: "全组进度"/);
  assert.match(dashboard, /id: "inbox", label: "待我处理"/);
  assert.match(dashboard, /id: "cohort", label: "课题组"/);
  assert.match(dashboard, /typeof window === "undefined"\) return "overview"/);
  assert.match(dashboard, /useState<MentorView>\("overview"\)/);
  assert.match(dashboard, /view === "settings" \? "overview" : view/);
  assert.match(overview, /fetch\("\/api\/dashboard\/overview", \{ cache: "no-store" \}\)/);
  assert.match(dashboard, /\["overview", "issues"\]\.includes\(mentorViewFromUrl\(\)\)\) void loadOverviewShell\(\)/);
  assert.match(dashboard, /onAuthenticated=\{async \(\) => \{[\s\S]*\["overview", "issues"\]\.includes\(mentorViewFromUrl\(\)\)[\s\S]*loadOverviewShell\(\)/);
  assert.match(dashboard, /fetch\("\/api\/auth\/session", \{ cache: "no-store" \}\)/);
  assert.match(sessionRoute, /private, no-store/);
  assert.match(overview, /searchParams\.set\("q", normalized\)/);
  assert.match(overview, /addEventListener\("popstate"/);
  assert.doesNotMatch(overview, /method:\s*"(?:POST|PATCH|DELETE)"/);
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /event\.key === "Escape"/);
  assert.match(drawer, /event\.key !== "Tab"/);
  assert.match(drawer, /setAttribute\("inert", ""\)/);
  assert.match(table, /data-overview-student/);
  assert.match(table, /role="columnheader"/);
  assert.match(table, /role="cell"/);
  assert.match(table, /onClick=\{\(event\) => \{[\s\S]*onOpen\(student\.studentId\)/);
  assert.match(table, /event\.key !== "Enter" && event\.key !== " "/);
  assert.match(mobile, /group-overview-mobile-list/);
  assert.match(css, /@media \(max-width: 1280px\)/);
  assert.match(css, /\.group-overview-mobile-list\s*\{\s*display: grid/);
  assert.match(css, /\.group-overview-state-cell \{[^}]*grid-template-columns:\s*29px/);
  assert.match(css, /\.group-overview-position > span \{[^}]*grid-template-columns:\s*20px/);
  assert.match(css, /\.group-overview-issue-list article \{[^}]*grid-template-columns:\s*27px/);
  assert.match(css, /--state-color:\s*#925f14/);
  assert.match(css, /--state-color:\s*#656d71/);
});


test("problem records share a student-filtered destination while plans and reported results retain their precise targets", () => {
  for (const kind of ["blocker", "next_action"]) {
    const expected = `/students/student-1#progress-resolution-12-${kind}`;
    assert.equal(overviewActionHref(student({ primaryAction: kind === "blocker" ? "resolve_blocker" : "follow_up", primaryActionTargetId: 12, issues: [{ sourceType: "paper" }] })), kind === "blocker" ? "/?mentorView=issues&issueStudent=student-1" : expected);
    assert.equal(overviewActionHref(student({ primaryAction: "review_resolution", primaryActionTargetId: 12, issues: [{ sourceType: "resolution", resolutionKind: kind }] })), expected);
  }
  for (const sourceType of ["paper", "progress", "milestone"]) {
    const row = student({ studentId: "学生/甲&state=all", primaryAction: "resolve_blocker", primaryActionTargetId: 12, issues: [{ sourceType }] });
    assert.equal(overviewActionLabel(row), "查看问题记录");
    assert.equal(overviewActionHref(row), `/?mentorView=issues&issueStudent=${encodeURIComponent(row.studentId)}`);
  }
  assert.equal(overviewActionHref(student({ primaryAction: "follow_up", primaryActionTargetId: 12, issues: [{ sourceType: "guidance" }] })), "/students/student-1#guidance-12");
  assert.equal(overviewActionHref(student({ primaryAction: "follow_up", primaryActionTargetId: 12, issues: [{ sourceType: "milestone" }] })), "/students/student-1#milestone-12");
});
