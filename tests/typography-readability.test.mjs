import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("mentor overview no longer uses unreadable 7–9px information text", () => {
  const overviewCss = css.slice(css.indexOf("/* V46 mentor group overview */"));

  assert.ok(overviewCss.length > 0);
  assert.doesNotMatch(overviewCss, /font-size:\s*[789]px/);
  assert.match(css, /\.group-overview-table-head[^}]*font-size:\s*12px/);
  assert.match(css, /\.group-overview-state-cell time[^}]*font-size:\s*11px/);
  assert.match(css, /\.group-overview-student-cell strong[^}]*font-size:\s*14px/);
  assert.match(css, /\.group-overview-primary-action[^}]*font-size:\s*13px/);
  assert.match(css, /@media \(max-width: 1280px\)/);
  assert.match(css, /\.group-overview-mobile-list h3[^}]*font-size:\s*15px/);
});

test("shared mentor controls keep a readable information hierarchy", () => {
  assert.match(css, /\.nav-item[^}]*font-size:\s*14px/);
  assert.match(css, /\.global-search input[^}]*font-size:\s*14px/);
  assert.match(css, /\.top-actions button, button\.primary[^}]*font-size:\s*14px/);
  assert.match(css, /\.review-actions button[^}]*font-size:\s*14px/);
  assert.match(css, /\.review-evidence p[^}]*font-size:\s*14px/);
});

test("student primary workflows and mobile forms meet the new readability floor", () => {
  assert.match(css, /\.student-section-nav a[^}]*font-size:\s*13px/);
  assert.match(css, /\.student-next-action > div > strong[^}]*font-size:\s*14px/);
  assert.match(css, /\.student-output-grid h3[^}]*font-size:\s*15px/);
  assert.match(css, /\.student-timeline-card > p[^}]*font-size:\s*13px/);
  assert.match(css, /\.student-workbench-sidebar nav > a, \.student-workbench-sidebar nav > button[^}]*font-size:\s*14px/);
  assert.match(css, /\.student-quick-progress textarea,\n\s*\.proposal-editor input,[^}]*font-size:\s*16px/);
});
