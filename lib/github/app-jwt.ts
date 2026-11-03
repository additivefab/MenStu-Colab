// GitHub App authentication primitives (Web Crypto only, no runtime imports),
// so the same code runs in the Worker and in plain Node tests.
// Docs: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
//   - RS256 (RSASSA-PKCS1-v1_5 + SHA-256)
//   - iat 60 s in the past to absorb clock drift
//   - exp no more than 10 minutes after now
//   - iss = App ID (or client ID)

export class GithubKeyFormatError extends Error {}

const textEncoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array | string) {
  const data = typeof bytes === "string" ? textEncoder.encode(bytes) : bytes;
  let binary = "";
  for (let index = 0; index < data.length; index += 0x8000) {
    binary += String.fromCharCode(...data.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Decode(value: string) {
  let binary: string;
  try { binary = atob(value); } catch { throw new GithubKeyFormatError("GitHub App 私钥不是有效的 PEM"); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function derLength(length: number) {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

// PrivateKeyInfo ::= SEQUENCE { version 0, AlgorithmIdentifier rsaEncryption NULL, OCTET STRING pkcs1 }
function wrapPkcs1InPkcs8(pkcs1: Uint8Array) {
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const bodyLength = version.length + algorithm.length + octet.length + pkcs1.length;
  const out = new Uint8Array(1 + derLength(bodyLength).length + bodyLength);
  out.set([0x30, ...derLength(bodyLength), ...version, ...algorithm, ...octet]);
  out.set(pkcs1, out.length - pkcs1.length);
  return out;
}

/** Accepts PKCS#8 ("BEGIN PRIVATE KEY") or the PKCS#1 file GitHub downloads
 * ("BEGIN RSA PRIVATE KEY"); tolerates `\n`-escaped secrets and CRLF. */
export function privateKeyPemToPkcs8(pem: string) {
  const normalized = pem.replace(/\\n/g, "\n").replace(/\r/g, "").trim();
  const match = /^-----BEGIN (RSA )?PRIVATE KEY-----\n?([A-Za-z0-9+/=\s]+?)\n?-----END (RSA )?PRIVATE KEY-----$/.exec(normalized);
  if (!match || Boolean(match[1]) !== Boolean(match[3])) {
    throw new GithubKeyFormatError("GitHub App 私钥格式无效，需为 PEM（PKCS#8 或 PKCS#1）");
  }
  const der = base64Decode(match[2].replace(/\s+/g, ""));
  return match[1] ? wrapPkcs1InPkcs8(der) : der;
}

export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "pkcs8", privateKeyPemToPkcs8(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
    );
  } catch (error) {
    if (error instanceof GithubKeyFormatError) throw error;
    throw new GithubKeyFormatError("GitHub App 私钥无法导入");
  }
}

export const APP_JWT_LIFETIME_SECONDS = 9 * 60;
export const APP_JWT_BACKDATE_SECONDS = 60;

export async function createAppJwt(appId: string, key: CryptoKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({
    iat: nowSeconds - APP_JWT_BACKDATE_SECONDS,
    exp: nowSeconds + APP_JWT_LIFETIME_SECONDS,
    // Numeric App IDs are sent as JSON numbers; client IDs ("Iv1…") as strings.
    iss: /^\d+$/.test(appId) ? Number(appId) : appId,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, textEncoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}
