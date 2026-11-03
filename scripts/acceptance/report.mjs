#!/usr/bin/env node
// Runs the automated test suite with a machine-readable reporter, maps test
// titles to the acceptance matrix (design pack 05, T01–T26) and writes
// docs/acceptance/验收状态.md.
//
// Usage:
//   node scripts/acceptance/report.mjs [--build] [--results <file.jsonl>] [--out <file.md>]
//
//   --build      run `npm run build` first (the worker tests load dist/server).
//   --results    reuse a JSONL file written by jsonl-reporter.mjs instead of
//                running the tests again.
//   --out        output path (default docs/acceptance/验收状态.md).
//
// Exit code is 1 when any test failed or the test run itself failed; the
// report is written either way.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { ACCEPTANCE, EXPLICIT_EVIDENCE, extractIds } from "./mapping.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORTER = join(ROOT, "scripts", "acceptance", "jsonl-reporter.mjs");
const DEFAULT_OUT = join(ROOT, "docs", "acceptance", "验收状态.md");

const STATUS = {
  pass: "自动化通过",
  fail: "自动化失败",
  realOnly: "仅真实环境可验",
  none: "未覆盖",
};

function parseCli() {
  const { values } = parseArgs({
    options: {
      build: { type: "boolean", default: false },
      results: { type: "string" },
      out: { type: "string", default: DEFAULT_OUT },
    },
  });
  return values;
}

/** The test files `npm test` runs, read from the package.json test script. */
export function testFilesFromPackage(root = ROOT) {
  const script = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.test ?? "";
  const files = [];
  for (const token of script.split(/\s+/)) {
    const match = /^([\w./-]+)\/\*\.test\.mjs$/.exec(token);
    if (!match) continue;
    const directory = join(root, match[1]);
    for (const name of readdirSync(directory).sort()) {
      if (name.endsWith(".test.mjs")) files.push(join(match[1], name));
    }
  }
  if (files.length === 0) throw new Error("package.json scripts.test names no <dir>/*.test.mjs globs");
  return files;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function runTests(resultsPath) {
  const files = testFilesFromPackage();
  console.log(`acceptance: running ${files.length} test files`);
  return run(process.execPath, [
    "--experimental-strip-types",
    "--test",
    `--test-reporter=${REPORTER}`,
    `--test-reporter-destination=${resultsPath}`,
    "--test-reporter=dot",
    "--test-reporter-destination=stdout",
    ...files,
  ]);
}

export function readResults(path) {
  const tests = [];
  let summary = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.kind === "summary") summary = record;
    else if (record.kind === "test") tests.push({ ...record, file: relative(ROOT, record.file) || record.file });
  }
  return { tests, summary };
}

function outcome(test) {
  if (test.skipped || test.todo) return "skipped";
  return test.passed ? "passed" : "failed";
}

/** Joins test results with the mapping. Returns per-ID evidence and stale mapping entries. */
export function buildMatrix(tests) {
  const evidence = new Map(ACCEPTANCE.map((item) => [item.id, new Map()]));
  const add = (id, test, source) => {
    const key = `${test.file}\u0000${test.path.join("\u0000")}`;
    const existing = evidence.get(id).get(key);
    if (existing) existing.sources.add(source);
    else evidence.get(id).set(key, { test, sources: new Set([source]) });
  };
  for (const test of tests) {
    for (const id of extractIds(test.name)) add(id, test, "标题");
  }
  const unmatched = [];
  for (const entry of EXPLICIT_EVIDENCE) {
    const hits = tests.filter((test) => test.file === entry.file && test.name.startsWith(entry.title));
    if (hits.length === 0) unmatched.push(entry);
    for (const test of hits) for (const id of entry.ids) add(id, test, "映射表");
  }
  const rows = ACCEPTANCE.map((item) => {
    const items = [...evidence.get(item.id).values()].sort((a, b) =>
      a.test.file.localeCompare(b.test.file) || a.test.path.join(" › ").localeCompare(b.test.path.join(" › ")));
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const { test } of items) counts[outcome(test)] += 1;
    let status;
    if (counts.failed > 0) status = STATUS.fail;
    else if (item.mode === "real-only") status = STATUS.realOnly;
    else if (counts.passed === 0) status = STATUS.none;
    else status = STATUS.pass;
    return { ...item, status, counts, items };
  });
  return { rows, unmatched };
}

function gitInfo() {
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const sha = git(["rev-parse", "--short", "HEAD"]);
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  return { sha: sha ?? "未知", dirty: Boolean(dirty) };
}

const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const label = { passed: "通过", failed: "失败", skipped: "跳过" };

export function renderReport({ rows, unmatched, tests, summary, runExitCode, generatedAt, git }) {
  const totals = { passed: 0, failed: 0, skipped: 0 };
  for (const test of tests) totals[outcome(test)] += 1;
  const reported = summary?.counts ?? null;
  const tally = (status) => rows.filter((row) => row.status === status).map((row) => row.id);
  const lines = [];
  lines.push("# 验收矩阵自动化状态（T01–T26）");
  lines.push("");
  lines.push("> 本文件由 `scripts/acceptance/report.mjs` 生成，请勿手改。");
  lines.push("> **只反映自动化测试的结果。外部系统（GitHub、Codex / Claude、Slurm、Apptainer、GPU、飞书）在测试中均为模拟或替身；“自动化通过”不等于真实环境验收，本报告中没有任何一项经过真实环境验证。**");
  lines.push("");
  lines.push("## 运行信息");
  lines.push("");
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push(`- 代码版本：\`${git.sha}\`${git.dirty ? "（工作区有未提交的已跟踪文件改动）" : ""}`);
  lines.push(`- 运行环境：Node ${process.version}，${process.platform}/${process.arch}`);
  lines.push(`- 测试文件：与 \`npm test\` 相同（读取 package.json 的 test 脚本）`);
  lines.push(`- 测试结果：共 ${tests.length} 项，通过 ${totals.passed}，失败 ${totals.failed}，跳过 ${totals.skipped}` +
    (reported ? `（node:test 汇总：tests ${reported.tests}，pass ${reported.passed}，fail ${reported.failed}，skipped ${reported.skipped}）` : "（未取得 node:test 汇总）"));
  lines.push(`- 测试进程退出码：${runExitCode === null ? "未运行（复用已有结果）" : runExitCode}`);
  lines.push("");
  lines.push("## 状态说明");
  lines.push("");
  lines.push(`- **${STATUS.pass}**：有对应的自动化测试且全部通过（外部系统为模拟）。仍需的真实环境验证见表格最后一列。`);
  lines.push(`- **${STATUS.fail}**：至少一项对应测试失败。`);
  lines.push(`- **${STATUS.realOnly}**：验收标准本身针对真实外部系统或真实隔离边界；列出的模拟测试只是佐证，不能使其通过。`);
  lines.push(`- **${STATUS.none}**：没有对应的自动化测试。`);
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push("| 状态 | 数量 | 验收 ID |");
  lines.push("|---|---|---|");
  for (const status of Object.values(STATUS)) {
    const ids = tally(status);
    lines.push(`| ${status} | ${ids.length} | ${ids.join("、") || "—"} |`);
  }
  lines.push("");
  lines.push("## 逐项状态");
  lines.push("");
  lines.push("| ID | 场景 | 状态 | 证据（通过 / 失败 / 跳过） | 外部系统模拟情况 | 仍需的真实环境验证 |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of rows) {
    const counts = row.items.length === 0 ? "无" : `${row.counts.passed} / ${row.counts.failed} / ${row.counts.skipped}`;
    lines.push(`| ${row.id} | ${cell(row.scenario)} | ${row.status} | ${counts} | ${cell(row.simulated)} | ${cell(row.realCheck)} |`);
  }
  lines.push("");
  lines.push("## 证据明细");
  lines.push("");
  lines.push("来源“标题”表示测试标题里写明了验收 ID；“映射表”表示由 `scripts/acceptance/mapping.mjs` 的显式映射得出。");
  for (const row of rows) {
    lines.push("");
    lines.push(`### ${row.id} ${row.scenario} — ${row.status}`);
    lines.push("");
    if (row.items.length === 0) {
      lines.push("没有对应的自动化测试。");
    } else {
      if (row.mode === "real-only") lines.push("以下模拟测试仅作佐证，不构成该项验收。");
      if (row.mode === "real-only") lines.push("");
      for (const { test, sources } of row.items) {
        const result = label[outcome(test)];
        const error = outcome(test) === "failed" && test.error ? `：${cell(test.error).slice(0, 200)}` : "";
        lines.push(`- ${result} · \`${test.file}\` · ${cell(test.path.join(" › "))}（${[...sources].join("、")}）${error}`);
      }
    }
    lines.push("");
    lines.push(`仍需的真实环境验证：${row.realCheck}`);
  }
  lines.push("");
  lines.push("## 映射表自检");
  lines.push("");
  if (unmatched.length === 0) {
    lines.push("映射表中的每一条都匹配到了测试。");
  } else {
    lines.push("以下映射条目没有匹配到任何测试（测试被改名或删除），请更新 `scripts/acceptance/mapping.mjs`：");
    lines.push("");
    for (const entry of unmatched) lines.push(`- ${entry.ids.join("、")} · \`${entry.file}\` · ${cell(entry.title)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const options = parseCli();
  let runExitCode = null;
  let resultsPath = options.results ? resolve(options.results) : null;
  if (!resultsPath) {
    if (options.build && run("npm", ["run", "build"]) !== 0) {
      console.error("acceptance: npm run build failed");
      process.exit(1);
    }
    if (!existsSync(join(ROOT, "dist", "server", "index.js"))) {
      console.error("acceptance: dist/server/index.js is missing; run `npm run build` first or pass --build");
      process.exit(1);
    }
    resultsPath = join(mkdtempSync(join(tmpdir(), "acceptance-")), "results.jsonl");
    runExitCode = runTests(resultsPath);
  }
  if (!existsSync(resultsPath)) {
    console.error(`acceptance: no results at ${resultsPath}`);
    process.exit(1);
  }
  const { tests, summary } = readResults(resultsPath);
  const { rows, unmatched } = buildMatrix(tests);
  const markdown = renderReport({
    rows, unmatched, tests, summary, runExitCode,
    generatedAt: new Date().toISOString(),
    git: gitInfo(),
  });
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, markdown);

  const failed = tests.filter((test) => outcome(test) === "failed").length;
  console.log(`acceptance: ${tests.length} tests (${failed} failed); results ${resultsPath}`);
  for (const status of Object.values(STATUS)) {
    const ids = rows.filter((row) => row.status === status).map((row) => row.id);
    console.log(`acceptance: ${status} ${ids.length}${ids.length ? ` (${ids.join(", ")})` : ""}`);
  }
  if (unmatched.length > 0) console.log(`acceptance: ${unmatched.length} mapping entries matched no test`);
  console.log(`acceptance: wrote ${relative(ROOT, options.out)}`);
  if (summary?.counts && summary.counts.tests !== tests.length) {
    console.error(`acceptance: reporter saw ${tests.length} tests but node:test reported ${summary.counts.tests}`);
    process.exit(1);
  }
  if (failed > 0 || (runExitCode !== null && runExitCode !== 0)) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
