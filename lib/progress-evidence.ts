export type ReviewStatus = "submitted" | "in_review" | "accepted" | "changes_requested" | "rejected";
export type ProgressAssessment = "substantive" | "supporting" | null;

export async function sha256Text(value: string) {
  return sha256Bytes(new TextEncoder().encode(value));
}

export async function sha256Bytes(value: BufferSource) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function legacyProgressStatus(reviewStatus: ReviewStatus, assessment: ProgressAssessment) {
  if (reviewStatus === "accepted") return assessment === "substantive" ? "substantive" : "supporting";
  if (reviewStatus === "changes_requested") return "supplement";
  if (reviewStatus === "rejected") return "rejected";
  return "pending";
}

export function validateHttpsUrl(value: string, label: string) {
  if (!value) return "";
  if (value.length > 2048) throw new Error(`${label}不能超过 2048 个字符`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label}格式无效`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label}必须使用 HTTPS`);
  return parsed.toString();
}

export function evidenceDisplayRef(sourceType: string, sourceRef: string) {
  if (!sourceRef) return "";
  if (["git", "url"].includes(sourceType)) return sourceRef;
  if (sourceType === "doi") return sourceRef.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "");
  if (sourceType.startsWith("feishu_")) return "";
  return sourceRef.slice(0, 300);
}
