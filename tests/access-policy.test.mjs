import assert from "node:assert/strict";
import test from "node:test";

import { roleCanViewStudent, scopeSql } from "../lib/access-policy.ts";

test("student data access defaults to deny outside the explicit role scope", () => {
  assert.equal(roleCanViewStudent({ role: "superadmin", studentId: null }, "student-a", []), true);
  assert.equal(roleCanViewStudent({ role: "admin", studentId: null }, "student-a", ["student-a"]), true);
  assert.equal(roleCanViewStudent({ role: "admin", studentId: null }, "student-b", ["student-a"]), false);
  assert.equal(roleCanViewStudent({ role: "student", studentId: "student-a" }, "student-a", []), true);
  assert.equal(roleCanViewStudent({ role: "student", studentId: "student-a" }, "student-b", []), false);
  assert.equal(roleCanViewStudent({ role: "pending", studentId: null }, "student-a", ["student-a"]), false);
  assert.equal(roleCanViewStudent({ role: "unexpected", studentId: null }, "student-a", ["student-a"]), false);
});

test("database scopes deny an empty admin assignment and bind assigned students", () => {
  assert.deepEqual(scopeSql({ all: true, studentIds: [] }, "s.id"), { clause: "", bindings: [] });
  assert.deepEqual(scopeSql({ all: false, studentIds: [] }, "s.id"), { clause: " AND 1 = 0", bindings: [] });
  assert.deepEqual(scopeSql({ all: false, studentIds: ["student-a", "student-b"] }, "s.id"), {
    clause: " AND s.id IN (?,?)",
    bindings: ["student-a", "student-b"],
  });
});
