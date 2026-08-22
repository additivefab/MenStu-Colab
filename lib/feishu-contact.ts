export type FeishuContactIdentifier = {
  kind: "email" | "mobile";
  value: string;
};

export function normalizeFeishuContact(kind: "email" | "mobile", value: string) {
  const trimmed = value.trim();
  return kind === "email" ? trimmed.toLowerCase() : trimmed.replace(/[\s()-]/g, "");
}

export function isValidFeishuContact(kind: "email" | "mobile", value: string) {
  if (kind === "email") return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return /^\+?\d{6,20}$/.test(value);
}
