import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1].split(",").map((selector) => selector.trim()),
  body: match[2],
}));

function assertRuleDeclaration(selector, declaration) {
  const matchingRules = rules.filter((rule) => rule.selectors.includes(selector));
  assert.ok(matchingRules.length > 0, `missing CSS selector: ${selector}`);
  assert.ok(
    matchingRules.some((rule) => declaration.test(rule.body)),
    `${selector} is missing ${declaration}`,
  );
}

function assertFontSize(selector, size) {
  assertRuleDeclaration(selector, new RegExp(`font-size:\\s*${size}px`));
}

test("mentor overview keeps a readable information hierarchy", () => {
  const markerIndex = css.indexOf("/* V46 mentor group overview */");
  assert.notEqual(markerIndex, -1);
  const overviewCss = css.slice(markerIndex);

  assert.doesNotMatch(overviewCss, /font-size:\s*(?:7|8|9|10)px/);
  assertFontSize(".group-overview-table-head", 12);
  assertFontSize(".group-overview-state-cell time", 11);
  assertFontSize(".group-overview-student-cell strong", 14);
  assertFontSize(".group-overview-primary-action", 13);
  assertFontSize(".group-overview-mobile-list h3", 15);
  assert.match(css, /@media \(max-width: 1280px\)/);
});

test("shared mentor controls and decisions keep a readable hierarchy", () => {
  assertFontSize(".nav-item", 14);
  assertFontSize(".global-search input", 14);
  assertFontSize("button.primary", 14);
  assertFontSize(".review-actions button", 14);
  assertFontSize(".review-evidence p", 14);
  assertFontSize(".empty-small", 13);
  assertFontSize(".mentor-evidence-strip b", 13);
  assertFontSize(".mentor-inline-guidance label", 12);
  assertFontSize(".mentor-version-diff p", 13);

  const breakpointStart = css.lastIndexOf("@media (max-width: 1000px) and (min-width: 781px)");
  const breakpointEnd = css.indexOf("@media (max-width: 780px)", breakpointStart);
  assert.notEqual(breakpointStart, -1);
  assert.notEqual(breakpointEnd, -1);
  const breakpointCss = css.slice(breakpointStart, breakpointEnd);
  assert.match(breakpointCss, /\.command-shortcuts \{ display:\s*none; \}/);
  assert.match(breakpointCss, /\.mentor-inbox-workspace \{ grid-template-columns:\s*1fr; \}/);
});

test("student core workflows keep main text and secondary information readable", () => {
  assertFontSize(".student-section-nav a", 13);
  assertFontSize(".student-next-action > div > strong", 14);
  assertFontSize(".student-output-grid h3", 15);
  assertFontSize(".student-timeline-card > p", 13);
  assertFontSize(".student-workbench-sidebar nav > a", 14);
  assertFontSize(".student-guidance-evidence p", 13);
  assertFontSize(".student-ai-summary-body blockquote p", 13);
  assertFontSize(".student-paper-decision strong", 13);
  assertFontSize(".student-progress-evidence > p", 13);
  assertFontSize(".student-revision-history li > p", 13);
  assertFontSize(".student-guidance-note-body > p", 13);
});

test("mobile text controls keep the 16px anti-zoom floor", () => {
  assertFontSize(".student-quick-progress textarea", 16);
  assertFontSize(".proposal-editor input", 16);
  assertFontSize(".modal textarea", 16);
  assertFontSize(".mentor-inline-guidance textarea", 16);
  assertFontSize(".student-guidance-compose select", 16);
  assertFontSize(".student-guidance-list textarea", 16);
  assertFontSize(".student-guidance-inbox-list footer input", 16);
});

test("the active interface keeps an 11px absolute typography floor", () => {
  for (const match of css.matchAll(/font-size:\s*([0-9]+(?:\.[0-9]+)?)px/g)) {
    assert.ok(Number(match[1]) >= 11, `font-size ${match[1]}px is below the 11px floor`);
  }
  for (const match of css.matchAll(/font:\s*([0-9]+(?:\.[0-9]+)?)px(?:\/[^\s;]+)?/g)) {
    assert.ok(Number(match[1]) >= 11, `font shorthand ${match[1]}px is below the 11px floor`);
  }
});
