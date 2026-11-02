import { env } from "cloudflare:workers";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY_ENV_NAMES = [
  "RESEARCH_OUTPUT_CREDENTIALS_KEY",
  "RESEARCH_OUTPUTS_ENCRYPTION_KEY",
  "RESEARCH_OUTPUT_PASSWORD_KEY",
] as const;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hexToBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let offset = 0; offset < value.length; offset += 2) {
    bytes[offset / 2] = Number.parseInt(value.slice(offset, offset + 2), 16);
  }
  return bytes;
}

function configuredSecret() {
  const environment = env as unknown as Record<string, unknown>;
  for (const name of KEY_ENV_NAMES) {
    const value = typeof environment[name] === "string" ? environment[name].trim() : "";
    if (value) return value;
  }
  return "";
}

async function keyBytes() {
  const secret = configuredSecret();
  if (!secret) throw new Error("未配置投稿密码加密密钥，无法保存或读取投稿密码");
  // Accept deployment-friendly base64 or hex keys. Other values are treated as
  // passphrases and deterministically expanded to a 256-bit AES key.
  if (/^(?:[0-9a-f]{32}|[0-9a-f]{48}|[0-9a-f]{64})$/iu.test(secret)) {
    return hexToBytes(secret);
  }
  try {
    const decoded = base64ToBytes(secret);
    if ([16, 24, 32].includes(decoded.length)) return decoded;
  } catch {
    // Fall through to passphrase hashing.
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
}

async function importCredentialKey(usage: KeyUsage | KeyUsage[]) {
  return crypto.subtle.importKey("raw", await keyBytes(), { name: "AES-GCM" }, false, Array.isArray(usage) ? usage : [usage]);
}

export async function encryptResearchOutputPassword(password: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importCredentialKey("encrypt");
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(password)));
  return { ciphertext: bytesToBase64(ciphertext), iv: bytesToBase64(iv) };
}

export async function decryptResearchOutputPassword(ciphertext: string, iv: string) {
  const key = await importCredentialKey("decrypt");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return decoder.decode(plaintext);
}

