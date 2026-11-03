import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  APP_JWT_BACKDATE_SECONDS, APP_JWT_LIFETIME_SECONDS, GithubKeyFormatError, createAppJwt, importAppPrivateKey, privateKeyPemToPkcs8,
} from "../lib/github/app-jwt.ts";

// The RSA key is generated per run; no real GitHub App key is ever committed.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" });

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

function verifyJwt(jwt) {
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  assert.ok(parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)), "JWT segments are unpadded base64url");
  const valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
  assert.ok(valid, "signature verifies with the matching public key");
  return { header: decode(parts[0]), payload: decode(parts[1]) };
}

test("App JWT is RS256, backdated 60 s, expires within 10 minutes and names the App", async () => {
  const now = 1_800_000_000;
  const jwt = await createAppJwt("424242", await importAppPrivateKey(pkcs8), now);
  const { header, payload } = verifyJwt(jwt);
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.deepEqual(payload, { iat: now - APP_JWT_BACKDATE_SECONDS, exp: now + APP_JWT_LIFETIME_SECONDS, iss: 424242 });
  assert.ok(payload.exp - now <= 600, "GitHub rejects exp more than 10 minutes ahead");
  const clientIdJwt = verifyJwt(await createAppJwt("Iv23liFixture", await importAppPrivateKey(pkcs8), now));
  assert.equal(clientIdJwt.payload.iss, "Iv23liFixture");
});

test("PKCS#1 downloads and \\n-escaped secrets import to the same key", async () => {
  const escaped = pkcs8.trim().replace(/\n/g, "\\n");
  for (const pem of [pkcs1, escaped, pkcs1.replace(/\n/g, "\r\n")]) {
    const { payload } = verifyJwt(await createAppJwt("7", await importAppPrivateKey(pem), 1_800_000_000));
    assert.equal(payload.iss, 7);
  }
  const fromPkcs1 = createPublicKey({ key: Buffer.from(privateKeyPemToPkcs8(pkcs1)), format: "der", type: "pkcs8" });
  assert.equal(fromPkcs1.export({ type: "spki", format: "pem" }), publicKey.export({ type: "spki", format: "pem" }));
});

test("malformed or mismatched PEM input is rejected without echoing it", async () => {
  const bad = [
    "", "not a key", pkcs8.replace("BEGIN PRIVATE KEY", "BEGIN RSA PRIVATE KEY"),
    "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
    publicKey.export({ type: "spki", format: "pem" }),
  ];
  for (const pem of bad) {
    await assert.rejects(importAppPrivateKey(pem), (error) => {
      assert.ok(error instanceof GithubKeyFormatError);
      assert.ok(!error.message.includes("AAAA"));
      return true;
    });
  }
});
