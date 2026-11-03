import type { AppUser } from "./feishu-auth";

// FB1 (batch 5) CONTRACT STUB — E1 implements; keep the signature.
// True when `user` holds an active review delegation for `studentId`
// (review_delegations, active = 1, student active). Grants only routine code
// review (G2) of non-protected change requests and read access to that
// student's research-loop tasks, attempts and change requests. Never implies
// canViewStudent for other data, run approval, extra review or result review.
export async function canCodeReviewStudent(d1: D1Database, user: AppUser, studentId: string): Promise<boolean> {
  void d1; void user; void studentId;
  return false;
}
