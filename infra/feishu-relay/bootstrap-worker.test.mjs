import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";

import { handleBootstrapRequest } from "./bootstrap-worker.mjs";

globalThis.crypto ??= webcrypto;

async function encryptedRequest(payload, encryptKey) {
  const keyBytes = createHash("sha256").update(encryptKey).digest();
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
  const iv = new Uint8Array(16).fill(7);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, plaintext));
  const encrypted = Buffer.concat([Buffer.from(iv), Buffer.from(ciphertext)]).toString("base64");
  const rawBody = JSON.stringify({ encrypt: encrypted });
  const timestamp = "1787310000";
  const nonce = "verification-nonce";
  const signature = createHash("sha256")
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
    .digest("hex");
  return new Request("https://relay.example/feishu/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    },
    body: rawBody,
  });
}

test("answers a valid encrypted URL verification without calling upstream", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("upstream must not be called");
  });
  const encryptKey = "temporary-test-encrypt-key";
  const request = await encryptedRequest(
    { type: "url_verification", challenge: "challenge-value" },
    encryptKey,
  );

  const response = await handleBootstrapRequest(request, { FEISHU_ENCRYPT_KEY: encryptKey });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: "challenge-value" });
  assert.equal(upstream.mock.callCount(), 0);
});

test("rejects a verification request with an invalid signature", async () => {
  const request = await encryptedRequest(
    { type: "url_verification", challenge: "challenge-value" },
    "temporary-test-encrypt-key",
  );
  const headers = new Headers(request.headers);
  headers.set("x-lark-signature", "invalid");
  const tampered = new Request(request.url, {
    method: request.method,
    headers,
    body: await request.text(),
  });

  const response = await handleBootstrapRequest(tampered, {
    FEISHU_ENCRYPT_KEY: "temporary-test-encrypt-key",
  });

  assert.equal(response.status, 403);
});
