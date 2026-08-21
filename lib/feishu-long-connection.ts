const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function secureEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function createLongConnectionRelaySignature(
  rawBody: string,
  secret: string,
  timestamp: string,
  nonce: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}\n${nonce}\n${rawBody}`),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyLongConnectionRelay(
  rawBody: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
) {
  if (!secret) return false;
  const timestamp = headers.get("x-tanyan-timestamp") ?? "";
  const nonce = headers.get("x-tanyan-nonce") ?? "";
  const signature = (headers.get("x-tanyan-signature") ?? "").toLowerCase();
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > 300) return false;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = await createLongConnectionRelaySignature(rawBody, secret, timestamp, nonce);
  return secureEqual(expected, signature);
}
