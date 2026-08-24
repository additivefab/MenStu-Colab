import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { overviewActionHref, overviewActionLabel } from "../components/dashboard-overview/overview-actions.ts";
import { earliestOverviewDueDate, parseOverviewUrl, sortOverviewStudents } from "../components/dashboard-overview/overview-view-model.ts";

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
});

test("overview sorting is stable by state, earliest deadline, oldest trusted progress, then identity", () => {
  const issue = (dueDate) => [{ dueDate }];
  const rows = [
    student({ studentId: "d", displayName: "丁", primaryState: "student", issues: issue("2026-08-25") }),
    student({ studentId: "b", displayName: "乙", primaryState: "mentor", issues: issue("2026-08-27") }),
    student({ studentId: "a", displayName: "甲", primaryState: "intervene", issues: issue("2026-08-24") }),
    student({ studentId: "c", displayName: "丙", primaryState: "mentor", issues: issue("2026-08-26") }),
    student({ studentId: "f", displayName: "己", primaryState: "on_track", latestSubstantiveAt: "2026-08-21T00:00:00Z" }),
    student({ studentId: "e", displayName: "戊", primaryState: "on_track", latestSubstantiveAt: null }),
  ];
  assert.deepEqual(rows.sort(sortOverviewStudents).map((row) => row.studentId), ["a", "c", "b", "d", "e", "f"]);
});

test("earliest deadline is the minimum across all issues rather than the primary issue date", () => {
  const row = student({ issues: [{ dueDate: "2026-09-30" }, { dueDate: null }, { dueDate: "2026-08-20" }] });
  assert.equal(earliestOverviewDueDate(row), "2026-08-20");
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
  assert.match(dashboard, /mentorViewFromUrl\(\) === "overview"\) void loadOverviewShell\(\)/);
  assert.match(dashboard, /onAuthenticated=\{async \(\) => \{[\s\S]*mentorViewFromUrl\(\) === "overview"[\s\S]*loadOverviewShell\(\)/);
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
});
