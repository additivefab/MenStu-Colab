export type UserRole = "superadmin" | "admin" | "mentor" | "student" | "pending";

export type RoleChangeDecision =
  | { allowed: true; bootstrapSuperAdmin: boolean }
  | { allowed: false; status: 400 | 403 | 409; error: string };

export function decideRoleChange(input: {
  callerRole: UserRole;
  callerUserId: number;
  targetUserId: number;
  targetRole: UserRole;
  nextRole: UserRole;
  activeSuperAdmins: number;
}): RoleChangeDecision {
  const {
    callerRole, callerUserId, targetUserId, targetRole, nextRole, activeSuperAdmins,
  } = input;
  const callerIsSuperAdmin = callerRole === "superadmin";

  if (callerRole !== "superadmin" && callerRole !== "admin") {
    return { allowed: false, status: 403, error: "当前账号不能管理角色" };
  }
  if (callerUserId === targetUserId && nextRole !== targetRole) {
    return { allowed: false, status: 400, error: "不能修改自己的高权限角色" };
  }
  if (!callerIsSuperAdmin && (targetRole === "superadmin" || targetRole === "admin")) {
    return { allowed: false, status: 403, error: "普通管理员不能修改管理员或超级管理员" };
  }
  if (nextRole === "admin" && !callerIsSuperAdmin && targetRole !== "admin") {
    return { allowed: false, status: 403, error: "只有超级管理员可以授予管理员角色" };
  }
  const bootstrapSuperAdmin = nextRole === "superadmin"
    && callerRole === "admin"
    && activeSuperAdmins === 0
    && callerUserId !== targetUserId;
  if (nextRole === "superadmin" && !callerIsSuperAdmin && !bootstrapSuperAdmin) {
    return {
      allowed: false,
      status: 403,
      error: "只有超级管理员可以授予超级管理员；首次授予仅允许执行一次",
    };
  }
  if (targetRole === "superadmin" && nextRole !== "superadmin" && activeSuperAdmins <= 1) {
    return { allowed: false, status: 409, error: "不能移除最后一名超级管理员" };
  }
  return { allowed: true, bootstrapSuperAdmin };
}
