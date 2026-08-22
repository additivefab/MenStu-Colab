import assert from "node:assert/strict";
import test from "node:test";

import { evidenceDisplayRef, legacyProgressStatus, sha256Text, validateHttpsUrl } from "../lib/progress-evidence.ts";

test("review workflow and assessment double-write the compatible legacy status", () => {
  assert.equal(legacyProgressStatus("accepted", "substantive"), "substantive");
  assert.equal(legacyProgressStatus("accepted", "supporting"), "supporting");
  assert.equal(legacyProgressStatus("changes_requested", null), "supplement");
  assert.equal(legacyProgressStatus("rejected", null), "rejected");
  assert.equal(legacyProgressStatus("submitted", null), "pending");
});

test("external evidence links require HTTPS and internal Feishu identifiers stay hidden", () => {
  assert.equal(validateHttpsUrl("https://github.com/example/private", "Git 链接"), "https://github.com/example/private");
  assert.throws(() => validateHttpsUrl("http://example.com", "证据链接"), /HTTPS/);
  assert.throws(() => validateHttpsUrl("javascript:alert(1)", "证据链接"), /HTTPS/);
  assert.equal(evidenceDisplayRef("feishu_docx", "message-secret-id"), "");
  assert.equal(evidenceDisplayRef("feishu_minutes", "minute-secret-id"), "");
  assert.equal(evidenceDisplayRef("git", "https://github.com/example/private"), "https://github.com/example/private");
});

test("evidence content fingerprints are deterministic SHA-256 values", async () => {
  assert.equal((await sha256Text("same evidence")).length, 64);
  assert.equal(await sha256Text("same evidence"), await sha256Text("same evidence"));
  assert.notEqual(await sha256Text("same evidence"), await sha256Text("different evidence"));
});
