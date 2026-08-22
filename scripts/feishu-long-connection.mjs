import { createHmac, randomBytes } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";

import {
  detectMeetingSummary,
  detectSummaryImportCommand,
  extractFeishuDocxDocumentIds,
  extractFeishuMinuteTokens,
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
const minuteArtifacts = new Map();
const docxSummaries = new Map();
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

function boundedMinuteArtifacts(data) {
  return {
    summary: (data.summary || "").slice(0, 60_000),
    chapters: (data.minute_chapters || []).slice(0, 100).map((chapter) => ({
      title: (chapter.title || "").slice(0, 500),
      start_ms: chapter.start_ms || "",
      stop_ms: chapter.stop_ms || "",
      summary_content: (chapter.summary_content || "").slice(0, 4_000),
    })),
    todos: (data.minute_todos || []).slice(0, 200).map((todo) => ({
      content: (todo.content || "").slice(0, 2_000),
      assignees: (todo.assignees || []).slice(0, 30),
      is_done: Boolean(todo.is_done),
    })),
    keywords: (data.keywords || []).slice(0, 80).map((keyword) => keyword.slice(0, 300)),
  };
}

async function fetchMinuteArtifacts(minuteToken) {
  if (minuteArtifacts.has(minuteToken)) return minuteArtifacts.get(minuteToken);
  const task = (async () => {
    const response = await apiClient.minutes.v1.minute.artifacts({ path: { minute_token: minuteToken } });
    if (response.code && response.code !== 0) {
      throw new Error(`飞书妙记接口返回 code ${response.code}`);
    }
    const artifacts = boundedMinuteArtifacts(response.data || {});
    const hasContent = Boolean(
      artifacts.summary || artifacts.chapters.length || artifacts.todos.length || artifacts.keywords.length,
    );
    return hasContent ? artifacts : null;
  })().catch((error) => {
    console.warn(`[探研] 妙记 AI 产物暂不可读取 · ${error instanceof Error ? error.message : "未知错误"}`);
    return null;
  });
  minuteArtifacts.set(minuteToken, task);
  setTimeout(() => minuteArtifacts.delete(minuteToken), 15 * 60 * 1000);
  return task;
}

async function enrichMinuteMessage(event, text) {
  const minuteToken = extractFeishuMinuteTokens(text)[0];
  if (!minuteToken) return null;
  const artifacts = await fetchMinuteArtifacts(minuteToken);
  if (!artifacts) return null;
  return {
    ...event,
    message: {
      ...event.message,
      content: JSON.stringify({
        type: "飞书妙记 AI 会议纪要",
        minute_token: minuteToken,
        original_content: event.message?.content || "",
        ai_artifacts: artifacts,
      }),
    },
  };
}

async function fetchDocxSummary(documentId) {
  if (docxSummaries.has(documentId)) return docxSummaries.get(documentId);
  const task = (async () => {
    const response = await apiClient.docx.v1.document.rawContent({ path: { document_id: documentId } });
    if (response.code && response.code !== 0) {
      throw new Error(`飞书文档接口返回 code ${response.code}`);
    }
    const content = (response.data?.content || "").trim().slice(0, 60_000);
    return content && detectMeetingSummary(content) ? content : null;
  })().catch((error) => {
    console.warn(`[探研] 智能纪要文档暂不可读取 · ${error instanceof Error ? error.message : "未知错误"}`);
    return null;
  });
  docxSummaries.set(documentId, task);
  setTimeout(() => docxSummaries.delete(documentId), 15 * 60 * 1000);
  return task;
}

async function enrichDocxMessage(event, text) {
  if (!detectMeetingSummary(text)) return null;
  const documentId = extractFeishuDocxDocumentIds(text)[0];
  if (!documentId) return null;
  const summary = await fetchDocxSummary(documentId);
  if (!summary) return null;
  return {
    ...event,
    message: {
      ...event.message,
      content: JSON.stringify({
        type: "飞书智能纪要 AI 文档",
        document_id: documentId,
        original_content: event.message?.content || "",
        ai_summary: summary,
      }),
    },
  };
}

async function enrichMeetingMessage(event, text) {
  return await enrichMinuteMessage(event, text) || await enrichDocxMessage(event, text);
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
  if (!chatId) {
    console.error("[探研] 无法扫描群历史：当前命令缺少群聊 ID。");
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
      if (detectSummaryImportCommand(text)) continue;
      const candidateEvent = historyEvent(commandEvent, item);
      const enrichedEvent = await enrichMeetingMessage(candidateEvent, text);
      if (!enrichedEvent && !detectMeetingSummary(text)) continue;
      matched += 1;
      await forwardWithRetry(enrichedEvent || candidateEvent);
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

async function handleGroupMessage(event, text) {
  const enrichedEvent = await enrichMeetingMessage(event, text);
  if (enrichedEvent) {
    await forwardWithRetry(enrichedEvent);
    return;
  }
  if (detectMeetingSummary(text)) await forwardWithRetry(event);
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
    if (!detectMeetingSummary(text) && extractFeishuMinuteTokens(text).length === 0) return;
    void handleGroupMessage(event, text);
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
  console.info("[探研] 飞书长连接客户端已启动；普通群消息会在本机过滤，不会上传；支持妙记 AI 产物、智能纪要文档与“导入所有总结”。");
}

startBridge().catch(() => {
  console.error("[探研] 飞书长连接客户端启动失败，将由系统自动重试。");
  process.exitCode = 1;
});
