import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";

// OWASP scrypt profile: 16 MiB, r=8, p=5. Supported by Workers node:crypto.
const PREFIX = "scrypt:16384:8:5";
export function passwordError(password: unknown): string | null {
  if (typeof password !== "string" || [...password].length < 15 || [...password].length > 128) {
    return "密码须为 15–128 个字符，可以使用较长的短语";
  }
  return null;
}
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32,
    { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}
export const INITIAL_STUDENT_PASSWORD = "123456789";
export function loginPasswordError(password: unknown) {
  return typeof password !== "string" || password.length < 1 || [...password].length > 128;
}
async function encodePassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${PREFIX}:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function hashPassword(password: string) {
  const error = passwordError(password);
  if (error) throw new Error(error);
  return encodePassword(password);
}
// Only administrative initialization may use the short shared initial password.
export function hashInitialPassword() { return encodePassword(INITIAL_STUDENT_PASSWORD); }
export async function verifyPassword(password: string, encoded: string | null) {
  const match = encoded?.match(/^scrypt:16384:8:5:([a-f0-9]{32}):([a-f0-9]{64})$/);
  // Unknown/unactivated accounts do the same expensive work as existing accounts.
  const actual = await derive(password, match?.[1] ?? "0".repeat(32));
  const expected = Buffer.from(match?.[2] ?? "0".repeat(64), "hex");
  return timingSafeEqual(actual, expected) && Boolean(match);
}
export function secretToken() { return randomBytes(32).toString("hex"); }
export function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function normalizeUsername(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
