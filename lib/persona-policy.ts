export type PersonaRole = "superadmin" | "admin" | "student" | "pending";
export type AppPersona = "management" | "student";

export type PersonaResolution = {
  role: PersonaRole;
  activePersona: AppPersona;
  canSwitchPersona: boolean;
};

/**
 * A persona cookie is only a user preference. The persisted role and current
 * student binding are re-evaluated on every request before an effective role
 * is returned.
 */
export function resolvePersona(
  primaryRole: PersonaRole,
  studentId: string | null,
  requestedPersona?: string,
): PersonaResolution {
  if (primaryRole === "student") {
    return { role: "student", activePersona: "student", canSwitchPersona: false };
  }

  const canSwitchPersona = (primaryRole === "superadmin" || primaryRole === "admin") && Boolean(studentId);
  if (requestedPersona === "student" && canSwitchPersona) {
    return { role: "student", activePersona: "student", canSwitchPersona: true };
  }

  return { role: primaryRole, activePersona: "management", canSwitchPersona };
}
