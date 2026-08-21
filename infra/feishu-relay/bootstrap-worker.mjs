import relayWorker from "./worker.mjs";

const encoder = new TextEncoder();

function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function toHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function secureEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifySignature(rawBody, encryptKey, headers) {
  const timestamp = headers.get("x-lark-request-timestamp") || "";
  const nonce = headers.get("x-lark-request-nonce") || "";
  const signature = headers.get("x-lark-signature") || "";
  if (!timestamp || !nonce || !signature) return false;
  const expected = toHex(await sha256(`${timestamp}${nonce}${encryptKey}${rawBody}`));
  return secureEqual(expected, signature.toLowerCase());
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function decryptPayload(encryptedValue, encryptKey) {
  const encrypted = decodeBase64(encryptedValue);
  if (encrypted.byteLength <= 16) throw new Error("invalid encrypted payload");
  const key = await crypto.subtle.importKey(
    "raw",
    await sha256(encryptKey),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: encrypted.slice(0, 16) },
    key,
    encrypted.slice(16),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export async function handleBootstrapRequest(request, env = {}) {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/feishu/events" || !env.FEISHU_ENCRYPT_KEY) {
    return relayWorker.fetch(request, env);
  }

  try {
    const forwardedRequest = request.clone();
    const rawBody = await request.text();
    if (!(await verifySignature(rawBody, env.FEISHU_ENCRYPT_KEY, request.headers))) {
      return jsonResponse({ error: "invalid signature" }, 403);
    }

    const envelope = JSON.parse(rawBody);
    const payload = typeof envelope.encrypt === "string"
      ? await decryptPayload(envelope.encrypt, env.FEISHU_ENCRYPT_KEY)
      : envelope;
    if (payload.type === "url_verification") {
      return jsonResponse({ challenge: payload.challenge || "" });
    }
    return relayWorker.fetch(forwardedRequest, env);
  } catch {
    return jsonResponse({ error: "invalid verification request" }, 400);
  }
}

export default {
  fetch(request, env) {
    return handleBootstrapRequest(request, env);
  },
};
