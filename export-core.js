(function exposeExportCore(globalScope) {
  "use strict";

  const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
  const MAX_FILENAME_LENGTH = 96;

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatTimestamp(timestamp = Date.now()) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function dateStamp(timestamp = Date.now()) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "unknown-date";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function sanitizeFileName(value, fallback = "ChatGPT-Conversation") {
    const cleaned = String(value || fallback)
      .replace(ILLEGAL_FILENAME_CHARS, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+([._-])/g, "$1")
      .replace(/([._-])\s+/g, "$1")
      .trim()
      .slice(0, MAX_FILENAME_LENGTH)
      .trim();
    return cleaned || fallback;
  }

  function roleLabel(role) {
    if (role === "user") return "用户";
    if (role === "assistant") return "ChatGPT";
    return role || "未知角色";
  }

  function statusLabel(conversation) {
    const status = conversation?.capture?.status || "partial";
    const table = {
      complete: "完整保存",
      scanning: "扫描中",
      paused: "已暂停",
      gapped: "存在顺序缺口",
      stale: "需要更新",
      partial: "部分保存"
    };
    return table[status] || table.partial;
  }

  function isComplete(conversation) {
    return conversation?.capture?.status === "complete" && !conversation?.capture?.hasGaps;
  }

  function normalizeMessages(conversation, archive) {
    const messages = archive?.getMessages
      ? archive.getMessages(conversation)
      : (conversation?.messages || []);
    return messages
      .filter((message) => message && message.text)
      .map((message, index) => ({
        index: index + 1,
        role: message.role,
        text: String(message.text).replace(/\r\n/g, "\n").trim(),
        firstSeenAt: message.firstSeenAt || null,
        lastSeenAt: message.lastSeenAt || null
      }));
  }

  function messageCount(conversation, archive) {
    return archive?.getMessageCount
      ? archive.getMessageCount(conversation)
      : normalizeMessages(conversation, archive).length;
  }

  function markdownEscapeTitle(value) {
    return String(value || "未命名对话").replace(/\n+/g, " ").trim();
  }

  function formatMarkdownConversation(conversation, options) {
    const archive = options.archive;
    const generatedAt = options.generatedAt || Date.now();
    const messages = normalizeMessages(conversation, archive);
    const lines = [
      `# ${markdownEscapeTitle(conversation.title)}`,
      "",
      `- 来源：ChatGPT`,
      `- 对话链接：${conversation.url || "未记录"}`,
      `- 保存状态：${statusLabel(conversation)}`,
      `- 消息数量：${messageCount(conversation, archive)}`,
      `- 是否完整：${isComplete(conversation) ? "是" : "否"}`,
      `- 导出时间：${formatTimestamp(generatedAt)}`,
      `- 插件：ChatGPT 对话寻踪`,
      ""
    ];

    if (!isComplete(conversation)) {
      lines.push("> 注意：这个对话尚未标记为完整保存，导出内容可能缺少未加载过的消息。", "");
    }

    lines.push("---", "");

    for (const message of messages) {
      lines.push(`## ${String(message.index).padStart(3, "0")} ${roleLabel(message.role)}`, "");
      lines.push(message.text || "（空消息）", "");
      lines.push("---", "");
    }

    return lines.join("\n").trimEnd() + "\n";
  }

  function formatTextConversation(conversation, options) {
    const archive = options.archive;
    const generatedAt = options.generatedAt || Date.now();
    const messages = normalizeMessages(conversation, archive);
    const separator = "=".repeat(54);
    const lightSeparator = "-".repeat(54);
    const lines = [
      conversation.title || "未命名对话",
      "",
      "来源：ChatGPT",
      `对话链接：${conversation.url || "未记录"}`,
      `保存状态：${statusLabel(conversation)}`,
      `消息数量：${messageCount(conversation, archive)}`,
      `是否完整：${isComplete(conversation) ? "是" : "否"}`,
      `导出时间：${formatTimestamp(generatedAt)}`,
      `插件：ChatGPT 对话寻踪`,
      ""
    ];

    if (!isComplete(conversation)) {
      lines.push("注意：这个对话尚未标记为完整保存，导出内容可能缺少未加载过的消息。", "");
    }

    lines.push(separator, "");

    for (const message of messages) {
      lines.push(`[${String(message.index).padStart(3, "0")}] ${roleLabel(message.role)}`, "");
      lines.push(message.text || "（空消息）", "");
      lines.push(lightSeparator, "");
    }

    return lines.join("\n").trimEnd() + "\n";
  }

  function formatConversation(conversation, options = {}) {
    const format = options.format === "txt" ? "txt" : "markdown";
    return format === "txt"
      ? formatTextConversation(conversation, options)
      : formatMarkdownConversation(conversation, options);
  }

  function exportConversations(conversations, options = {}) {
    const selected = (conversations || []).filter(Boolean);
    const format = options.format === "txt" ? "txt" : "markdown";
    const extension = format === "txt" ? "txt" : "md";
    const mime = format === "txt" ? "text/plain;charset=utf-8" : "text/markdown;charset=utf-8";
    const generatedAt = options.generatedAt || Date.now();
    const archive = options.archive;

    if (!selected.length) {
      throw new Error("NO_CONVERSATIONS_SELECTED");
    }

    const content = selected
      .map((conversation, index) => {
        const body = formatConversation(conversation, { format, archive, generatedAt });
        if (selected.length === 1) return body;
        const divider = format === "txt"
          ? `\n\n${"#".repeat(64)}\n\n`
          : "\n\n<!-- conversation-boundary -->\n\n";
        return index === 0 ? body : `${divider}${body}`;
      })
      .join("");

    const baseName = selected.length === 1
      ? sanitizeFileName(`${selected[0].title || "ChatGPT 对话"}_${dateStamp(generatedAt)}`)
      : sanitizeFileName(`ChatGPT 对话导出_${selected.length}段_${dateStamp(generatedAt)}`);

    return {
      content,
      filename: `${baseName}.${extension}`,
      mime,
      format,
      conversationCount: selected.length,
      messageCount: selected.reduce((sum, conversation) => sum + messageCount(conversation, archive), 0),
      incompleteCount: selected.filter((conversation) => !isComplete(conversation)).length
    };
  }

  const api = {
    formatTimestamp,
    sanitizeFileName,
    statusLabel,
    isComplete,
    normalizeMessages,
    formatConversation,
    exportConversations
  };

  globalScope.ChatRecallExport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
