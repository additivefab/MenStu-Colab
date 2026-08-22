import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  detectMeetingSummary,
  detectSummaryImportCommand,
  extractFeishuDocxDocumentIds,
  extractFeishuMinuteTokens,
  extractFeishuMessageText,
  parseFeishuEvent,
} from "../lib/feishu-events.ts";
import { splitMeetingProgressByStudent } from "../lib/feishu-progress-extraction.ts";

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

test("extracts only valid Feishu Minutes tokens from links", () => {
  assert.deepEqual(
    extractFeishuMinuteTokens("纪要：https://example.feishu.cn/minutes/obcnq3b9jl72l83w4f14xxxx"),
    ["obcnq3b9jl72l83w4f14xxxx"],
  );
  assert.deepEqual(
    extractFeishuMinuteTokens("https://applink.feishu.cn/client/minutes/detail?minute_token=obcnq3b9jl72l83w4f14xxxx"),
    ["obcnq3b9jl72l83w4f14xxxx"],
  );
  assert.deepEqual(
    extractFeishuMinuteTokens("https://feishu.cn.evil.example/minutes/obcnq3b9jl72l83w4f14xxxx"),
    [],
  );
});

test("extracts only valid Feishu Docx document IDs from links", () => {
  assert.deepEqual(
    extractFeishuDocxDocumentIds("智能纪要：https://example.feishu.cn/docx/Dz1udaUpEo5fL1xW1Zqc2NKdnB0?from=group"),
    ["Dz1udaUpEo5fL1xW1Zqc2NKdnB0"],
  );
  assert.deepEqual(
    extractFeishuDocxDocumentIds("https://feishu.cn.evil.example/docx/Dz1udaUpEo5fL1xW1Zqc2NKdnB0"),
    [],
  );
  assert.deepEqual(extractFeishuDocxDocumentIds("https://example.feishu.cn/wiki/Dz1udaUpEo5fL1xW1Zqc2NKdnB0"), []);
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

test("extracts only the unique student's research section from an intelligent note", () => {
  const note = `智能纪要：科研进展及课题组事务沟通会
会议时间：2026年8月21日
参会人：@佘阳@于兴华
科研工作进展汇报
文稿与绘图优化：完成文稿结构重构并优化首张大图。
移动与固定热源 PIN 对比：完成十次重复实验，数据稳定。
软硬约束实验结论：硬约束训练稳定性显著更优。
课题组事务沟通与决策
课题组官网建设：调整新闻宣传内容。`;
  const drafts = splitMeetingProgressByStudent(note, [
    { id: "student-002", displayName: "佘阳" },
    { id: "student-003", displayName: "张三" },
  ]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].studentId, "student-002");
  assert.match(drafts[0].title, /文稿与绘图优化/);
  assert.match(drafts[0].summary, /硬约束训练稳定性/);
  assert.doesNotMatch(drafts[0].summary, /会议时间|课题组官网/);
});

test("splits a multi-student meeting into independent progress drafts", () => {
  const note = `参会人：@张三@李四@导师
科研工作进展汇报
张三进展：完成缺陷分割基线复现。
指标验证：召回率提升 2.4%，形成可复现日志。
李四进展：完成探测器参数敏感性实验。
实验结论：确认曝光时间与噪声存在非线性关系。
课题组事务沟通与决策
下周调整服务器排期。`;
  const drafts = splitMeetingProgressByStudent(note, [
    { id: "student-a", displayName: "张三" },
    { id: "student-b", displayName: "李四" },
  ]);
  assert.deepEqual(drafts.map((draft) => draft.studentId), ["student-a", "student-b"]);
  assert.match(drafts[0].summary, /召回率提升/);
  assert.doesNotMatch(drafts[0].summary, /探测器参数/);
  assert.match(drafts[1].summary, /曝光时间与噪声/);
  assert.doesNotMatch(drafts[1].summary, /缺陷分割/);
});

test("keeps an ambiguous unlabeled multi-student report out of automatic assignment", () => {
  const note = `参会人：@张三@李四
科研工作进展汇报
本周完成两组实验并形成误差分析，下一步补充对照实验。`;
  assert.deepEqual(
    splitMeetingProgressByStudent(note, [
      { id: "student-a", displayName: "张三" },
      { id: "student-b", displayName: "李四" },
    ]),
    [],
  );
});
