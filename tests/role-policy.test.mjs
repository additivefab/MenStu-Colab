import assert from "node:assert/strict";
import test from "node:test";

import { decideRoleChange } from "../lib/role-policy.ts";

test("allows one audited bootstrap superadmin and then closes the bootstrap path", () => {
  assert.deepEqual(decideRoleChange({
    callerRole: "admin", callerUserId: 1, targetUserId: 2,
    targetRole: "pending", nextRole: "superadmin", activeSuperAdmins: 0,
  }), { allowed: true, bootstrapSuperAdmin: true });

  const second = decideRoleChange({
    callerRole: "admin", callerUserId: 1, targetUserId: 3,
    targetRole: "pending", nextRole: "superadmin", activeSuperAdmins: 1,
  });
  assert.equal(second.allowed, false);
  if (!second.allowed) assert.equal(second.status, 403);
});

test("only a superadmin can manage privileged roles", () => {
  const studentAttempt = decideRoleChange({
    callerRole: "student", callerUserId: 1, targetUserId: 2,
    targetRole: "pending", nextRole: "mentor", activeSuperAdmins: 1,
  });
  assert.equal(studentAttempt.allowed, false);

  const adminGrant = decideRoleChange({
    callerRole: "admin", callerUserId: 1, targetUserId: 2,
    targetRole: "mentor", nextRole: "admin", activeSuperAdmins: 1,
  });
  assert.equal(adminGrant.allowed, false);

  const adminEdit = decideRoleChange({
    callerRole: "admin", callerUserId: 1, targetUserId: 2,
    targetRole: "superadmin", nextRole: "mentor", activeSuperAdmins: 2,
  });
  assert.equal(adminEdit.allowed, false);

  assert.deepEqual(decideRoleChange({
    callerRole: "superadmin", callerUserId: 1, targetUserId: 2,
    targetRole: "admin", nextRole: "superadmin", activeSuperAdmins: 1,
  }), { allowed: true, bootstrapSuperAdmin: false });
});

test("prevents self-demotion and removal of the last superadmin", () => {
  const self = decideRoleChange({
    callerRole: "superadmin", callerUserId: 1, targetUserId: 1,
    targetRole: "superadmin", nextRole: "admin", activeSuperAdmins: 2,
  });
  assert.equal(self.allowed, false);
  if (!self.allowed) assert.equal(self.status, 400);

  const last = decideRoleChange({
    callerRole: "superadmin", callerUserId: 1, targetUserId: 2,
    targetRole: "superadmin", nextRole: "mentor", activeSuperAdmins: 1,
  });
  assert.equal(last.allowed, false);
  if (!last.allowed) assert.equal(last.status, 409);
});
