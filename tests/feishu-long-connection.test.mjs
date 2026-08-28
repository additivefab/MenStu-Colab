import assert from "node:assert/strict";
import test from "node:test";

import {
  createLongConnectionRelaySignature,
  verifyLongConnectionRelay,
} from "../lib/feishu-long-connection.ts";
import { formatFeishuImportFeedback } from "../lib/feishu-import-feedback.ts";

test("accepts a fresh authenticated long-connection relay request", async () => {
  const rawBody = JSON.stringify({ event_id: "evt", message: { message_id: "msg" } });
  const timestamp = "1787324000";
  const nonce = "nonce-for-test-1234";
  const secret = "test-app-secret";
  const signature = await createLongConnectionRelaySignature(rawBody, secret, timestamp, nonce);
  const headers = new Headers({
    "x-tanyan-timestamp": timestamp,
    "x-tanyan-nonce": nonce,
    "x-tanyan-signature": signature,
  });
  assert.equal(await verifyLongConnectionRelay(rawBody, headers, secret, 1787324000_000), true);
});

test("rejects stale or modified long-connection relay requests", async () => {
  const rawBody = JSON.stringify({ event_id: "evt" });
  const timestamp = "1787324000";
  const nonce = "nonce-for-test-1234";
  const secret = "test-app-secret";
  const signature = await createLongConnectionRelaySignature(rawBody, secret, timestamp, nonce);
  const headers = new Headers({
    "x-tanyan-timestamp": timestamp,
    "x-tanyan-nonce": nonce,
    "x-tanyan-signature": signature,
  });
  assert.equal(await verifyLongConnectionRelay(`${rawBody} `, headers, secret, 1787324000_000), false);
  assert.equal(await verifyLongConnectionRelay(rawBody, headers, secret, 1787325000_000), false);
});

test("turns relay outcomes into clear group feedback", () => {
  assert.match(
    formatFeishuImportFeedback({ outcome: "imported", studentNames: ["张三", "李四"] }),
    /张三、李四.*等待审核/,
  );
  assert.match(formatFeishuImportFeedback({ outcome: "duplicate" }), /无需重复/);
  assert.match(formatFeishuImportFeedback({ outcome: "needs_review" }), /人工确认/);
  assert.match(formatFeishuImportFeedback({ outcome: "relay_failed" }), /稍后再试/);
});
