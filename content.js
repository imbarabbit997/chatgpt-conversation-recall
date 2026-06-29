(function initializeChatRecall() {
  "use strict";

  if (window.__chatRecallLoaded) return;
  window.__chatRecallLoaded = true;

  const RECORD_PREFIX = "conversation:";
  const INDEX_KEY = "conversation:index";
  const PENDING_JUMP_KEY = "pendingJump";
  const BACKUP_FORMAT = "chatgpt-conversation-recall";
  const BACKUP_VERSION = 1;
  const MAX_RESULTS = 80;
  const core = globalThis.ChatRecallCore;

  const state = {
    conversations: new Map(),
    currentConversationId: null,
    scanTimer: null,
    saveTimer: null,
    lastFingerprint: "",
    panelOpen: false,
    searchQuery: ""
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function getConversationId(url = location.href) {
    try {
      const path = new URL(url).pathname;
      const match = path.match(/\/c\/([a-zA-Z0-9_-]+)/);
      return match?.[1] || null;
    } catch {
      return null;
    }
  }

  function getConversationTitle(messages) {
    const documentTitle = document.title
      .replace(/\s*[|·-]\s*ChatGPT\s*$/i, "")
      .trim();
    if (documentTitle && documentTitle.toLocaleLowerCase() !== "chatgpt") {
      return documentTitle;
    }
    const firstUserMessage = messages.find((message) => message.role === "user")?.text || "";
    return firstUserMessage.slice(0, 72).trim() || "未命名对话";
  }

  function findMessageId(element) {
    const carrier = element.closest("[data-message-id]") || element.querySelector("[data-message-id]");
    return carrier?.getAttribute("data-message-id") || null;
  }

  function extractMessages() {
    const roleNodes = [...document.querySelectorAll("[data-message-author-role]")];
    return roleNodes
      .map((node, index) => ({
        id: findMessageId(node) || `position-${index}`,
        role: node.getAttribute("data-message-author-role") || "unknown",
        text: (node.innerText || node.textContent || "").replace(/\n{3,}/g, "\n\n").trim()
      }))
      .filter((message) => message.text && ["user", "assistant"].includes(message.role));
  }

  function fingerprintMessages(id, title, messages) {
    const compact = messages.map((message) => `${message.role}:${message.id}:${message.text}`).join("\u241e");
    let hash = 2166136261;
    const source = `${id}\u241f${title}\u241f${compact}`;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${messages.length}:${hash >>> 0}`;
  }

  async function loadIndex() {
    const stored = await chrome.storage.local.get(INDEX_KEY);
    const index = Array.isArray(stored[INDEX_KEY]) ? stored[INDEX_KEY] : [];
    if (!index.length) {
      render();
      return;
    }

    const keys = index.map((item) => `${RECORD_PREFIX}${item.id}`);
    const records = await chrome.storage.local.get(keys);
    for (const item of index) {
      const record = records[`${RECORD_PREFIX}${item.id}`];
      if (record?.id && Array.isArray(record.messages)) {
        state.conversations.set(record.id, record);
      }
    }
    render();
  }

  async function persistConversation(conversation) {
    state.conversations.set(conversation.id, conversation);
    const index = [...state.conversations.values()]
      .map(({ id, title, url, updatedAt, messages }) => ({
        id,
        title,
        url,
        updatedAt,
        messageCount: messages.length
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);

    await chrome.storage.local.set({
      [`${RECORD_PREFIX}${conversation.id}`]: conversation,
      [INDEX_KEY]: index
    });
    render();
  }

  async function scanConversation() {
    const id = getConversationId();
    state.currentConversationId = id;
    if (!id) {
      setStatus("打开一段对话后便会开始收录");
      return;
    }

    const messages = extractMessages();
    if (!messages.length) {
      setStatus("正在等待对话内容出现…");
      return;
    }

    const title = getConversationTitle(messages);
    const fingerprint = fingerprintMessages(id, title, messages);
    if (state.lastFingerprint === fingerprint) return;
    state.lastFingerprint = fingerprint;

    const oldRecord = state.conversations.get(id);
    const conversation = {
      id,
      title,
      url: `${location.origin}${location.pathname}`,
      createdAt: oldRecord?.createdAt || Date.now(),
      updatedAt: Date.now(),
      messages
    };

    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      persistConversation(conversation).catch(() => {
        showToast("保存失败，请检查扩展的存储权限");
      });
    }, 450);

    setStatus(`正在收录当前对话 · ${messages.length} 条消息`);
    attemptPendingJump(id, messages);
  }

  function scheduleScan() {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(scanConversation, 260);
  }

  function formatDate(timestamp) {
    if (!timestamp) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(timestamp);
  }

  function highlight(text, query) {
    const tokens = core.tokenizeQuery(query)
      .sort((left, right) => right.length - left.length)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!tokens.length) return escapeHtml(text);
    const pattern = new RegExp(`(${tokens.join("|")})`, "giu");
    return escapeHtml(text).replace(pattern, "<mark>$1</mark>");
  }

  function getStats() {
    const conversations = [...state.conversations.values()];
    const messageCount = conversations.reduce((sum, item) => sum + item.messages.length, 0);
    return { conversationCount: conversations.length, messageCount };
  }

  function render() {
    if (!ui.results) return;
    const query = state.searchQuery.trim();
    const stats = getStats();
    ui.footerStats.textContent = `${stats.conversationCount} 段对话 · ${stats.messageCount} 条消息`;

    if (!query) {
      ui.results.innerHTML = `
        <div class="cr-empty">
          <div>
            <strong>${stats.conversationCount ? "记忆已经就位" : "从这一页开始记住"}</strong>
            <span>${stats.conversationCount
              ? "输入你记得的词，多个词之间可用空格分隔。"
              : "打开任意历史对话，或开始一段新对话；它会自动加入本地索引。"}</span>
          </div>
        </div>`;
      return;
    }

    const results = core.searchConversations(
      [...state.conversations.values()],
      query,
      MAX_RESULTS
    );

    if (!results.length) {
      ui.results.innerHTML = `
        <div class="cr-empty">
          <div>
            <strong>没有找到</strong>
            <span>这里只搜索安装扩展后实际打开过的对话。试试更短、更准确的关键词。</span>
          </div>
        </div>`;
      return;
    }

    ui.results.innerHTML = results.map((result, index) => `
      <button class="cr-result" type="button" data-result-index="${index}">
        <div class="cr-result-meta">
          <span class="cr-role">${result.role === "user" ? "你" : "GPT"}</span>
          <span>${escapeHtml(formatDate(result.updatedAt))}</span>
        </div>
        <p class="cr-result-title">${highlight(result.title, query)}</p>
        <p class="cr-snippet">${highlight(result.snippet, query)}</p>
      </button>`).join("");

    ui.results.querySelectorAll("[data-result-index]").forEach((button) => {
      button.addEventListener("click", () => {
        const result = results[Number(button.dataset.resultIndex)];
        openResult(result);
      });
    });
  }

  async function openResult(result) {
    await chrome.storage.local.set({
      [PENDING_JUMP_KEY]: {
        conversationId: result.conversationId,
        messageId: result.messageId,
        messageIndex: result.messageIndex,
        expiresAt: Date.now() + 60_000
      }
    });

    if (getConversationId() === result.conversationId) {
      await attemptPendingJump(result.conversationId, extractMessages());
      return;
    }
    location.assign(result.url);
  }

  async function attemptPendingJump(conversationId) {
    const stored = await chrome.storage.local.get(PENDING_JUMP_KEY);
    const pending = stored[PENDING_JUMP_KEY];
    if (!pending || pending.conversationId !== conversationId) return;
    if (pending.expiresAt < Date.now()) {
      await chrome.storage.local.remove(PENDING_JUMP_KEY);
      return;
    }

    const roleNodes = [...document.querySelectorAll("[data-message-author-role]")]
      .filter((node) => ["user", "assistant"].includes(node.getAttribute("data-message-author-role")));
    let target = null;
    if (pending.messageId && !pending.messageId.startsWith("position-")) {
      const escapedId = CSS.escape(pending.messageId);
      target = document.querySelector(`[data-message-id="${escapedId}"]`);
    }
    target ||= roleNodes[pending.messageIndex] || null;
    if (!target) return;

    const turn = target.closest("article") || target;
    turn.scrollIntoView({ behavior: "smooth", block: "center" });
    const previousOutline = turn.style.outline;
    const previousOffset = turn.style.outlineOffset;
    turn.style.outline = "3px solid rgba(197, 138, 45, .72)";
    turn.style.outlineOffset = "6px";
    setTimeout(() => {
      turn.style.outline = previousOutline;
      turn.style.outlineOffset = previousOffset;
    }, 2200);
    await chrome.storage.local.remove(PENDING_JUMP_KEY);
    showToast("已定位到命中消息");
  }

  async function clearAllData() {
    const confirmed = window.confirm("清除扩展收录的全部对话？这不会删除 ChatGPT 中的原始对话。");
    if (!confirmed) return;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => key.startsWith(RECORD_PREFIX));
    await chrome.storage.local.remove([...keys, INDEX_KEY, PENDING_JUMP_KEY]);
    state.conversations.clear();
    state.lastFingerprint = "";
    render();
    scheduleScan();
    showToast("本地索引已清空");
  }

  async function exportBackup() {
    const conversations = [...state.conversations.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt);
    if (!conversations.length) {
      showToast("当前没有可备份的对话");
      return;
    }

    const backup = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      conversationCount: conversations.length,
      conversations
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    const link = document.createElement("a");
    link.href = url;
    link.download = `chatgpt-对话寻踪备份-${date}.json`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    showToast(`已备份 ${conversations.length} 段对话`);
  }

  function isValidConversation(record) {
    return Boolean(
      record &&
      typeof record.id === "string" &&
      record.id &&
      typeof record.title === "string" &&
      typeof record.url === "string" &&
      Array.isArray(record.messages) &&
      record.messages.every((message) =>
        message &&
        typeof message.text === "string" &&
        typeof message.role === "string"
      )
    );
  }

  async function importBackup(file) {
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      showToast("无法读取备份：文件不是有效的 JSON");
      return;
    }

    if (
      backup?.format !== BACKUP_FORMAT ||
      backup?.version !== BACKUP_VERSION ||
      !Array.isArray(backup.conversations)
    ) {
      showToast("无法读取备份：格式或版本不兼容");
      return;
    }

    const incoming = backup.conversations.filter(isValidConversation);
    if (!incoming.length) {
      showToast("备份中没有有效对话");
      return;
    }

    let restored = 0;
    for (const conversation of incoming) {
      const existing = state.conversations.get(conversation.id);
      if (!existing || (conversation.updatedAt || 0) >= (existing.updatedAt || 0)) {
        state.conversations.set(conversation.id, conversation);
        restored += 1;
      }
    }

    const values = [...state.conversations.values()];
    const payload = Object.fromEntries(
      values.map((conversation) => [`${RECORD_PREFIX}${conversation.id}`, conversation])
    );
    payload[INDEX_KEY] = values
      .map(({ id, title, url, updatedAt, messages }) => ({
        id,
        title,
        url,
        updatedAt,
        messageCount: messages.length
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);

    try {
      await chrome.storage.local.set(payload);
      render();
      showToast(`恢复完成：写入 ${restored} 段对话`);
    } catch {
      showToast("恢复失败：浏览器无法写入本地存储");
    }
  }

  function setStatus(text) {
    if (ui.statusText) ui.statusText.textContent = text;
  }

  let toastTimer;
  function showToast(text) {
    ui.toast.textContent = text;
    ui.toast.dataset.show = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      ui.toast.dataset.show = "false";
    }, 2200);
  }

  function setPanelOpen(open) {
    state.panelOpen = open;
    ui.panel.dataset.open = String(open);
    ui.launcher.hidden = open;
    if (open) {
      setTimeout(() => ui.search.focus(), 80);
    }
  }

  const host = document.createElement("div");
  host.id = "chat-recall-extension";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("panel.css");
  shadow.appendChild(stylesheet);

  const root = document.createElement("div");
  root.innerHTML = `
    <button class="cr-launcher" type="button" title="打开对话寻踪（Alt+K）" aria-label="打开对话寻踪">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="6.5"></circle>
        <path d="m16 16 4 4M11 7.5v7M7.5 11h7"></path>
      </svg>
    </button>
    <aside class="cr-panel" data-open="false" aria-label="ChatGPT 对话搜索">
      <header class="cr-header">
        <div>
          <p class="cr-eyebrow">LOCAL CONVERSATION INDEX</p>
          <h2 class="cr-title">对话寻踪</h2>
        </div>
        <button class="cr-icon-button cr-close" type="button" title="关闭" aria-label="关闭">✕</button>
      </header>
      <div class="cr-search-wrap">
        <svg class="cr-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m16 16 4 4"></path>
        </svg>
        <input class="cr-search" type="search" autocomplete="off" placeholder="搜索打开过的对话…" />
        <span class="cr-shortcut">Alt K</span>
      </div>
      <div class="cr-status"><span class="cr-dot"></span><span class="cr-status-text">正在初始化本地索引…</span></div>
      <div class="cr-results"></div>
      <footer class="cr-footer">
        <span class="cr-footer-stats">0 段对话 · 0 条消息</span>
        <div class="cr-footer-actions">
          <button class="cr-footer-button cr-export" type="button">备份</button>
          <button class="cr-footer-button cr-import" type="button">恢复</button>
          <button class="cr-footer-button cr-clear" type="button">清空</button>
        </div>
        <span class="cr-backup-note">自动长期保存在本机；备份可用于重装或换电脑。</span>
        <input class="cr-file-input" type="file" accept=".json,application/json" hidden />
      </footer>
    </aside>
    <div class="cr-toast" data-show="false"></div>`;
  shadow.appendChild(root);

  const ui = {
    launcher: root.querySelector(".cr-launcher"),
    panel: root.querySelector(".cr-panel"),
    close: root.querySelector(".cr-close"),
    search: root.querySelector(".cr-search"),
    statusText: root.querySelector(".cr-status-text"),
    results: root.querySelector(".cr-results"),
    footerStats: root.querySelector(".cr-footer-stats"),
    export: root.querySelector(".cr-export"),
    import: root.querySelector(".cr-import"),
    clear: root.querySelector(".cr-clear"),
    fileInput: root.querySelector(".cr-file-input"),
    toast: root.querySelector(".cr-toast")
  };

  ui.launcher.addEventListener("click", () => setPanelOpen(true));
  ui.close.addEventListener("click", () => setPanelOpen(false));
  ui.search.addEventListener("input", debounce(() => {
    state.searchQuery = ui.search.value;
    render();
  }, 80));
  ui.export.addEventListener("click", exportBackup);
  ui.import.addEventListener("click", () => ui.fileInput.click());
  ui.fileInput.addEventListener("change", async () => {
    const [file] = ui.fileInput.files || [];
    if (file) await importBackup(file);
    ui.fileInput.value = "";
  });
  ui.clear.addEventListener("click", clearAllData);

  document.addEventListener("keydown", (event) => {
    if (event.altKey && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      setPanelOpen(!state.panelOpen);
    }
    if (event.key === "Escape" && state.panelOpen) {
      setPanelOpen(false);
    }
  }, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "CHAT_RECALL_TOGGLE") {
      setPanelOpen(!state.panelOpen);
    }
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      state.lastFingerprint = "";
      scheduleScan();
    }
  }, 800);

  loadIndex()
    .then(() => {
      scheduleScan();
      setStatus("打开一段对话后便会开始收录");
    })
    .catch(() => setStatus("无法读取本地索引，请重新加载扩展"));
})();
