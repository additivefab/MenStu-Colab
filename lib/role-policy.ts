export type UserRole = "superadmin" | "admin" | "student" | "pending";

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
  bootstrapTargetVerified?: boolean;
}): RoleChangeDecision {
  const {
    callerRole, callerUserId, targetUserId, targetRole, nextRole, activeSuperAdmins,
    bootstrapTargetVerified = false,
  } = input;
  const callerIsSuperAdmin = callerRole === "superadmin";
  const bootstrapSuperAdmin = nextRole === "superadmin"
    && callerRole === "admin"
    && callerUserId === targetUserId
    && targetRole === "admin"
    && activeSuperAdmins === 0
    && bootstrapTargetVerified;

  if (callerRole !== "superadmin" && callerRole !== "admin") {
    return { allowed: false, status: 403, error: "当前账号不能管理角色" };
  }
  if (callerIsSuperAdmin && callerUserId === targetUserId && nextRole !== targetRole) {
    return { allowed: false, status: 400, error: "不能修改自己的高权限角色" };
  }
  if (!callerIsSuperAdmin && !bootstrapSuperAdmin) {
    return {
      allowed: false,
      status: 403,
      error: "只有超级管理员可以管理账号角色；首次本人初始化仅允许执行一次",
    };
  }
  if (targetRole === "superadmin" && nextRole !== "superadmin" && activeSuperAdmins <= 1) {
    return { allowed: false, status: 409, error: "不能移除最后一名超级管理员" };
  }
  return { allowed: true, bootstrapSuperAdmin };
}
