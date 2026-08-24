import assert from "node:assert/strict";
import test from "node:test";

import { resolvePersona } from "../lib/persona-policy.ts";

test("persisted role and binding determine the available persona on every request", () => {
  assert.deepEqual(resolvePersona("student", "student-a", "management"), {
    role: "student",
    activePersona: "student",
    canSwitchPersona: false,
  });
  assert.deepEqual(resolvePersona("admin", null, "student"), {
    role: "admin",
    activePersona: "management",
    canSwitchPersona: false,
  });
  assert.deepEqual(resolvePersona("pending", "student-a", "student"), {
    role: "pending",
    activePersona: "management",
    canSwitchPersona: false,
  });
});

test("a bound administrator can switch only between management and their own student persona", () => {
  assert.deepEqual(resolvePersona("superadmin", "student-a", "management"), {
    role: "superadmin",
    activePersona: "management",
    canSwitchPersona: true,
  });
  assert.deepEqual(resolvePersona("superadmin", "student-a", "student"), {
    role: "student",
    activePersona: "student",
    canSwitchPersona: true,
  });
  assert.deepEqual(resolvePersona("admin", "student-a", "unexpected"), {
    role: "admin",
    activePersona: "management",
    canSwitchPersona: true,
  });
});
