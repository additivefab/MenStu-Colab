import { createHmac, randomBytes } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";

import {
  detectMeetingSummary,
  detectSummaryImportCommand,
  extractFeishuMessageText,
} from "../lib/feishu-events.ts";

const appId = process.env.FEISHU_APP_ID?.trim() ?? "";
const appSecret = process.env.FEISHU_APP_SECRET?.trim() ?? "";
const siteUrl = process.env.TANYAN_SITE_URL?.trim() || "https://progress.tz-ndt.com";
const relayUrl = new URL("/api/feishu/long-connection", siteUrl);

if (!/^cli_[0-9a-fA-F]{16}$/.test(appId) || !appSecret) {
  throw new Error("请配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
}

const pending = new Map();
const historyScans = new Map();
const maxHistoryMessages = 10_000;

const apiClient = new Lark.Client({
  appId,
  appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
});

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

function historySender(sender) {
  if (!sender?.id) return undefined;
  const idType = ["open_id", "user_id", "union_id", "app_id"].includes(sender.id_type)
    ? sender.id_type
    : "open_id";
  return {
    sender_id: { [idType]: sender.id },
    sender_type: sender.sender_type || "",
  };
}

function historyEvent(commandEvent, item) {
  const messageId = item.message_id || "";
  return {
    app_id: commandEvent.app_id,
    event_id: `history:${messageId}`,
    event_type: "im.message.receive_v1",
    token: commandEvent.token,
    sender: historySender(item.sender),
    message: {
      message_id: messageId,
      chat_id: item.chat_id || commandEvent.message?.chat_id || "",
      chat_type: "group",
      message_type: item.msg_type || "",
      content: item.body?.content || "",
      create_time: item.create_time || "",
    },
  };
}

async function scanChatHistory(commandEvent) {
  const chatId = commandEvent.message?.chat_id || "";
  if (!chatId || !commandEvent.token) {
    console.error("[探研] 无法扫描群历史：当前命令缺少必要的事件验证信息。");
    return;
  }

  let pageToken;
  let scanned = 0;
  let matched = 0;
  let truncated = false;

  while (scanned < maxHistoryMessages) {
    const response = await apiClient.im.v1.message.list({
      params: {
        container_id_type: "chat",
        container_id: chatId,
        sort_type: "ByCreateTimeDesc",
        page_size: 50,
        page_token: pageToken,
      },
    });
    if (response.code && response.code !== 0) {
      throw new Error(`飞书历史消息接口返回 code ${response.code}`);
    }

    const items = response.data?.items || [];
    for (const item of items) {
      if (scanned >= maxHistoryMessages) {
        truncated = true;
        break;
      }
      scanned += 1;
      if (!item.message_id || item.deleted) continue;
      const text = extractFeishuMessageText(item.body?.content || "");
      if (detectSummaryImportCommand(text) || !detectMeetingSummary(text)) continue;
      matched += 1;
      await forwardWithRetry(historyEvent(commandEvent, item));
    }

    if (!response.data?.has_more || !response.data.page_token || truncated) break;
    pageToken = response.data.page_token;
  }

  console.info(`[探研] 群历史扫描完成 · 扫描 ${scanned} 条 · 识别 ${matched} 份纪要${truncated ? " · 已达安全上限" : ""}`);
}

function startHistoryScan(event) {
  const chatId = event.message?.chat_id || "";
  if (!chatId || historyScans.has(chatId)) return;
  const task = scanChatHistory(event)
    .catch((error) => {
      console.error(`[探研] 群历史扫描失败 · ${error instanceof Error ? error.message : "未知错误"}`);
    })
    .finally(() => historyScans.delete(chatId));
  historyScans.set(chatId, task);
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (event) => {
    const message = event.message;
    if (!message || message.chat_type !== "group") return;
    const text = extractFeishuMessageText(message.content || "");
    if (detectSummaryImportCommand(text)) {
      startHistoryScan(event);
      return;
    }
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
  console.info("[探研] 飞书长连接客户端已启动；普通群消息会在本机过滤，不会上传；支持“导入所有总结”。");
}

startBridge().catch(() => {
  console.error("[探研] 飞书长连接客户端启动失败，将由系统自动重试。");
  process.exitCode = 1;
});
