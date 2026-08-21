import { createHmac, randomBytes } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";

import { detectMeetingSummary, extractFeishuMessageText } from "../lib/feishu-events.ts";

const appId = process.env.FEISHU_APP_ID?.trim() ?? "";
const appSecret = process.env.FEISHU_APP_SECRET?.trim() ?? "";
const siteUrl = process.env.TANYAN_SITE_URL?.trim() || "https://progress.tz-ndt.com";
const relayUrl = new URL("/api/feishu/long-connection", siteUrl);

if (!/^cli_[0-9a-fA-F]{16}$/.test(appId) || !appSecret) {
  throw new Error("请配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
}

const pending = new Map();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function relaySignature(rawBody, timestamp, nonce) {
  return createHmac("sha256", appSecret)
    .update(`${timestamp}\n${nonce}\n${rawBody}`)
    .digest("hex");
}

async function forwardOnce(event) {
  const rawBody = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  const response = await fetch(relayUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tanyan-timestamp": timestamp,
      "x-tanyan-nonce": nonce,
      "x-tanyan-signature": relaySignature(rawBody, timestamp, nonce),
    },
    body: rawBody,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`站点返回 HTTP ${response.status}`);
}

async function forwardWithRetry(event) {
  const messageId = event.message?.message_id ?? event.event_id ?? "unknown";
  if (pending.has(messageId)) return pending.get(messageId);
  const task = (async () => {
    let lastError;
    for (const delay of [0, 1_000, 3_000, 8_000, 15_000]) {
      if (delay) await sleep(delay);
      try {
        await forwardOnce(event);
        console.info(`[探研] 已暂存候选总结 · ${messageId.slice(-10)}`);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    console.error(`[探研] 候选总结转发失败 · ${messageId.slice(-10)} · ${lastError?.message || "未知错误"}`);
  })().finally(() => pending.delete(messageId));
  pending.set(messageId, task);
  return task;
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (event) => {
    const message = event.message;
    if (!message || message.chat_type !== "group") return;
    const text = extractFeishuMessageText(message.content || "");
    if (!detectMeetingSummary(text)) return;
    void forwardWithRetry(event);
  },
});

const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    wsClient.close({ force: true });
    process.exit(0);
  });
}

async function startBridge() {
  await wsClient.start({ eventDispatcher });
  console.info("[探研] 飞书长连接客户端已启动；普通群消息会在本机过滤，不会上传。");
}

startBridge().catch(() => {
  console.error("[探研] 飞书长连接客户端启动失败，将由系统自动重试。");
  process.exitCode = 1;
});
