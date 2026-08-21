import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  detectMeetingSummary,
  detectSummaryImportCommand,
  extractFeishuMessageText,
  parseFeishuEvent,
} from "../lib/feishu-events.ts";

function encryptedRequest(payload, encryptKey) {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString("base64");
  const rawBody = JSON.stringify({ encrypt: encrypted });
  const timestamp = "1787316000";
  const nonce = "test-nonce";
  const signature = createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${rawBody}`).digest("hex");
  return {
    rawBody,
    headers: new Headers({
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    }),
  };
}

test("decrypts and verifies Feishu encrypted event envelopes", async () => {
  const payload = { type: "url_verification", token: "token", challenge: "challenge-value" };
  const request = encryptedRequest(payload, "test-encrypt-key");
  assert.deepEqual(await parseFeishuEvent(request.rawBody, request.headers, "test-encrypt-key"), payload);
});

test("recognizes the explicit current-group history import command", () => {
  assert.equal(detectSummaryImportCommand("@_user_1 导入所有总结"), "导入所有总结");
  assert.equal(detectSummaryImportCommand("@探研，请导入全部 AI 总结。"), "导入全部AI总结");
  assert.equal(detectSummaryImportCommand("帮我看看以前的消息"), null);
});

test("rejects a Feishu event with an invalid signature", async () => {
  const request = encryptedRequest({ type: "url_verification" }, "test-encrypt-key");
  request.headers.set("x-lark-signature", "invalid");
  await assert.rejects(() => parseFeishuEvent(request.rawBody, request.headers, "test-encrypt-key"), /签名无效/);
});

test("filters ordinary messages and recognizes structured meeting summaries", () => {
  assert.equal(detectMeetingSummary("大家下午三点见，材料已发群里"), null);
  assert.equal(detectMeetingSummary("AI 总结：本次讨论确认下一步实验方案"), "AI 总结");
  const structured = "会议时间：今天。讨论内容：完成对照实验。".repeat(8);
  assert.equal(detectMeetingSummary(structured), "会议时间+讨论内容");
  assert.match(
    extractFeishuMessageText(JSON.stringify({ zh_cn: { title: "会议纪要", content: [[{ tag: "text", text: "行动项：于周五前复现实验" }]] } })),
    /行动项/,
  );
});
