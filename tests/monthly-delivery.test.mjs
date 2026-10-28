import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { summarizeMonthlyDelivery } from "../lib/monthly-delivery.ts";
import { readMonthlyDeliveries } from "../lib/monthly-delivery-service.ts";

const NOW = "2026-10-28T08:00:00.000Z";
const fact = (entryId, reviewStatus = "submitted", overrides = {}) => ({
  entryId, revisionNumber: 1, submittedAt: "2026-10-20 08:00:00", reviewStatus, ...overrides,
});

test("submission month uses Shanghai boundaries and revision creation, never confirmation month", () => {
  const summary = summarizeMonthlyDelivery([
    fact(1, "accepted", { submittedAt: "2026-09-30 15:59:59", reviewedAt: NOW }),
    fact(2, "accepted", { submittedAt: "2026-09-30 16:00:00" }),
    fact(3, "submitted", { submittedAt: "2026-11-01T00:00:00+08:00" }),
    fact(4, "submitted", { submittedAt: "2026-10-29 00:00:00" }),
    fact(5, "accepted", { submittedAt: "invalid" }),
  ], NOW);
  assert.deepEqual(summary, { month: "2026-10", phase: "confirmed", total: 1, confirmed: 1, pending: 0, needsChanges: 0, candidates: 0 });
  assert.equal(summarizeMonthlyDelivery([], "2026-12-31T16:00:00Z").month, "2027-01");
  assert.throws(() => summarizeMonthlyDelivery([], "invalid"));
});

test("each entry contributes only its last monthly revision and all entries affect the phase", () => {
  const facts = [
    fact(1, "changes_requested"),
    fact(1, "accepted", { revisionNumber: 2, submittedAt: "2026-10-21 08:00:00" }),
    fact(2, "accepted"),
    fact(3, "in_review"),
    fact(4, "rejected"),
    fact(5, "changes_requested", { submittedAt: "2026-09-20 08:00:00" }),
    fact(5, "submitted", { revisionNumber: 2 }),
  ];
  const summary = summarizeMonthlyDelivery(facts, NOW);
  assert.deepEqual(summary, { month: "2026-10", phase: "needs_changes", total: 5, confirmed: 2, pending: 2, needsChanges: 1, candidates: 0 });
  assert.equal(summarizeMonthlyDelivery(facts.filter((row) => row.entryId !== 4), NOW).phase, "submitted");
  assert.equal(summarizeMonthlyDelivery(facts.filter((row) => row.entryId <= 2), NOW).phase, "confirmed");
  assert.equal(summarizeMonthlyDelivery([], NOW).phase, "preparing");
});

test("AI minutes are candidates until accepted; an unresolved candidate does not reopen confirmed delivery", () => {
  const pending = fact(1, "submitted", { aiCandidate: true });
  assert.deepEqual(summarizeMonthlyDelivery([pending], NOW), {
    month: "2026-10", phase: "preparing", total: 0, confirmed: 0, pending: 0, needsChanges: 0, candidates: 1,
  });
  assert.deepEqual(summarizeMonthlyDelivery([pending, fact(2, "accepted", { aiCandidate: true }), fact(3, "changes_requested", { aiCandidate: true })], NOW), {
    month: "2026-10", phase: "confirmed", total: 1, confirmed: 1, pending: 0, needsChanges: 0, candidates: 2,
  });
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE students(id TEXT PRIMARY KEY, active INTEGER NOT NULL);
    CREATE TABLE progress_entries(id INTEGER PRIMARY KEY, student_id TEXT, kind TEXT, current_revision INTEGER, submitted_at TEXT);
    CREATE TABLE progress_revisions(progress_entry_id INTEGER, revision_number INTEGER, review_status TEXT, submitted_by_user_id INTEGER, created_at TEXT, reviewed_at TEXT);
    CREATE TABLE progress_deletions(progress_entry_id INTEGER PRIMARY KEY);
    CREATE TABLE progress_evidence_sources(progress_entry_id INTEGER, revision_number INTEGER, source_type TEXT, label TEXT);
    INSERT INTO students VALUES ('s1',1),('s2',1),('inactive',0);`);
  const calls = [];
  const prepare = (sql, bindings = []) => ({
    bind(...args) { return prepare(sql, args); },
    async all() {
      assert.ok(bindings.length <= 100);
      calls.push({ sql, bindings });
      return { results: db.prepare(sql).all(...bindings) };
    },
  });
  function entry(id, studentId, revisions, { ai = false, deleted = false } = {}) {
    db.prepare("INSERT INTO progress_entries VALUES (?,?,?,?,?)").run(id, studentId, ai ? "组会" : "项目", Math.max(...revisions.map((row) => row.revisionNumber)), "2026-08-01 08:00:00");
    for (const row of revisions) db.prepare("INSERT INTO progress_revisions VALUES (?,?,?,?,?,?)")
      .run(id, row.revisionNumber, row.reviewStatus, row.author === undefined ? (ai ? null : 1) : row.author, row.submittedAt, NOW);
    if (ai) db.prepare("INSERT INTO progress_evidence_sources VALUES (?,1,'feishu_minutes','飞书智能纪要')").run(id);
    if (deleted) db.prepare("INSERT INTO progress_deletions VALUES (?)").run(id);
  }
  return { db, calls, entry, d1: { prepare } };
}

test("database summary covers every monthly entry with scope, deletion, inactivity and AI author checks", async () => {
  const { db, d1, entry } = fixture();
  try {
    entry(1, "s1", [fact(1, "changes_requested"), fact(1, "accepted", { revisionNumber: 2 })]);
    entry(2, "s1", [fact(2, "submitted")]);
    entry(3, "s1", [fact(3, "rejected")]);
    entry(4, "s1", [fact(4, "accepted", { submittedAt: "2026-09-30 15:59:59" })]);
    entry(5, "s1", [fact(5, "accepted", { submittedAt: "2026-09-30 16:00:00" })]);
    entry(6, "s1", [fact(6, "changes_requested")], { deleted: true });
    entry(7, "s1", [fact(7, "submitted")], { ai: true });
    entry(8, "s1", [fact(8, "accepted")], { ai: true });
    entry(9, "s1", [fact(9, "changes_requested"), fact(9, "submitted", { revisionNumber: 2, author: 1 })], { ai: true });
    entry(10, "s1", [fact(10, "submitted", { submittedAt: "2026-10-29 00:00:00" })]);
    entry(11, "s2", [fact(11, "changes_requested")]);
    entry(12, "inactive", [fact(12, "changes_requested")]);
    const result = await readMonthlyDeliveries(d1, ["s1", "inactive"], NOW);
    assert.deepEqual(result.get("s1"), { month: "2026-10", phase: "needs_changes", total: 6, confirmed: 3, pending: 2, needsChanges: 1, candidates: 1 });
    assert.equal(result.has("s2"), false);
    assert.equal(result.get("inactive").total, 0);
  } finally { db.close(); }
});

test("database summaries are not truncated at 1000 entries and student batches stay under D1's bind budget", async () => {
  const { db, d1, entry, calls } = fixture();
  try {
    db.exec("BEGIN");
    for (let id = 1; id <= 1001; id += 1) entry(id, "s1", [fact(id, id === 1 ? "changes_requested" : "accepted")]);
    const ids = ["s1", ...Array.from({ length: 100 }, (_, i) => `batch-${i}`)];
    for (const id of ids.slice(1)) db.prepare("INSERT INTO students VALUES (?,1)").run(id);
    db.exec("COMMIT");
    const result = await readMonthlyDeliveries(d1, [...ids, "s1"], NOW);
    assert.equal(result.size, 101);
    assert.deepEqual(result.get("s1"), { month: "2026-10", phase: "needs_changes", total: 1001, confirmed: 1000, pending: 0, needsChanges: 1, candidates: 0 });
    assert.deepEqual(calls.map((call) => call.bindings.length), [93, 14]);
    assert.equal(result.get("batch-99").phase, "preparing");
    calls.length = 0;
    assert.equal((await readMonthlyDeliveries(d1, [], NOW)).size, 0);
    assert.equal(calls.length, 0);
  } finally { db.close(); }
});
