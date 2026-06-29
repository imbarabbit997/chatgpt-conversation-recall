(function initializeChatRecall() {
  "use strict";

  if (window.__chatRecallLoaded) return;
  window.__chatRecallLoaded = true;

  const RECORD_PREFIX = "conversation:";
  const INDEX_KEY = "conversation:index";
  const PENDING_JUMP_KEY = "pendingJump";
  const BACKUP_FORMAT = "chatgpt-conversation-recall";
  const BACKUP_VERSION = 2;
  const MAX_RESULTS = 80;
  const archive = globalThis.ChatRecallArchive;
  const searchCore = globalThis.ChatRecallCore;

  const state = {
    conversations: new Map(),
    currentConversationId: null,
    scanTimer: null,
    saveTimer: null,
    lastFingerprint: "",
    panelOpen: false,
    searchQuery: "",
    activeView: "search",
    filterStatus: "all",
    lastResults: [],
    capture: null,
    persistChain: Promise.resolve()
  };

  function escapeHtml(value) {
    return String(value ?? "")
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

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function getConversationId(url = location.href) {
    try {
      const match = new URL(url).pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
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
    const turn = element.closest("article")
      || element.closest('[data-testid^="conversation-turn"]')
      || element.parentElement;
    const carrier = element.closest("[data-message-id]")
      || turn?.querySelector("[data-message-id]")
      || element.querySelector("[data-message-id]");
    return carrier?.getAttribute("data-message-id") || null;
  }

  function extractMessages() {
    return [...document.querySelectorAll("[data-message-author-role]")]
      .map((node) => ({
        stableId: findMessageId(node),
        role: node.getAttribute("data-message-author-role") || "unknown",
        text: (node.innerText || node.textContent || "")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
        node
      }))
      .filter((message) => message.text && ["user", "assistant"].includes(message.role));
  }

  function fingerprintMessages(id, messages) {
    const source = messages
      .map((message) => `${message.role}:${message.stableId || ""}:${message.text}`)
      .join("\u241e");
    return `${id}:${messages.length}:${archive.hashString(source)}`;
  }

  function buildIndex() {
    return [...state.conversations.values()]
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        url: conversation.url,
        updatedAt: conversation.updatedAt,
        messageCount: archive.getMessageCount(conversation),
        captureStatus: conversation.capture?.status || "partial",
        completedAt: conversation.capture?.completedAt || null,
        hasGaps: Boolean(conversation.capture?.hasGaps)
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
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
    let migratedAny = false;
    for (const item of index) {
      const raw = records[`${RECORD_PREFIX}${item.id}`];
      const conversation = archive.migrateConversation(raw);
      if (conversation?.id) {
        state.conversations.set(conversation.id, conversation);
        if (raw?.schemaVersion !== archive.SCHEMA_VERSION) migratedAny = true;
      }
    }
    if (migratedAny) await persistAllConversations();
    render();
  }

  function persistConversation(conversation) {
    state.conversations.set(conversation.id, conversation);
    state.persistChain = state.persistChain
      .catch(() => {})
      .then(() => chrome.storage.local.set({
        [`${RECORD_PREFIX}${conversation.id}`]: conversation,
        [INDEX_KEY]: buildIndex()
      }));
    return state.persistChain.then(() => render());
  }

  async function persistAllConversations() {
    const values = [...state.conversations.values()];
    const payload = Object.fromEntries(
      values.map((conversation) => [`${RECORD_PREFIX}${conversation.id}`, conversation])
    );
    payload[INDEX_KEY] = buildIndex();
    await chrome.storage.local.set(payload);
  }

  async function harvestConversation(options = {}) {
    const id = getConversationId();
    state.currentConversationId = id;
    if (!id) {
      setStatus("打开一段对话后便会开始收录");
      render();
      return null;
    }

    const observedWithNodes = extractMessages();
    if (!observedWithNodes.length) {
      setStatus("正在等待对话内容出现…");
      return null;
    }

    const fingerprint = fingerprintMessages(id, observedWithNodes);
    if (!options.force && state.lastFingerprint === fingerprint) return null;
    state.lastFingerprint = fingerprint;

    const oldRecord = state.conversations.get(id);
    const title = getConversationTitle(observedWithNodes);
    const merged = archive.mergeObservation(
      oldRecord,
      observedWithNodes.map(({ stableId, role, text }) => ({ stableId, role, text })),
      {
        id,
        title,
        url: `${location.origin}${location.pathname}`,
        createdAt: oldRecord?.createdAt
      },
      {
        now: Date.now(),
        captureActive: Boolean(state.capture?.active)
      }
    );
    const conversation = merged.conversation;
    state.conversations.set(id, conversation);

    if (state.capture?.active && state.capture.conversationId === id) {
      state.capture.newCount += merged.newCount;
      state.capture.updatedCount += merged.updatedCount;
      state.capture.observedCount += observedWithNodes.length;
      state.capture.stableObservedCount += observedWithNodes.filter((item) => item.stableId).length;
    }

    if (options.immediate) {
      await persistConversation(conversation);
    } else {
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => {
        persistConversation(conversation).catch(() => {
          showToast("保存失败，请检查扩展的存储权限");
        });
      }, 420);
      render();
    }

    const count = archive.getMessageCount(conversation);
    const segmentText = conversation.capture.hasGaps
      ? ` · ${conversation.capture.segmentCount} 个区段`
      : "";
    setStatus(`本地已累积 ${count} 条消息${segmentText}`);
    attemptPendingJump(id).catch(() => {});
    return {
      ...merged,
      observedCount: observedWithNodes.length,
      stableCount: observedWithNodes.filter((item) => item.stableId).length,
      fingerprint
    };
  }

  function scheduleHarvest() {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      harvestConversation().catch(() => setStatus("收录失败，请重新加载扩展"));
    }, 260);
  }

  function formatDate(timestamp, includeYear = false) {
    if (!timestamp) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      ...(includeYear ? { year: "numeric" } : {}),
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(timestamp);
  }

  function highlight(text, query) {
    const tokens = searchCore.tokenizeQuery(query)
      .sort((left, right) => right.length - left.length)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!tokens.length) return escapeHtml(text);
    const pattern = new RegExp(`(${tokens.join("|")})`, "giu");
    return escapeHtml(text).replace(pattern, "<mark>$1</mark>");
  }

  function statusMeta(status) {
    const table = {
      complete: { label: "已完整", symbol: "✓", tone: "complete" },
      scanning: { label: "扫描中", symbol: "↧", tone: "scanning" },
      paused: { label: "已暂停", symbol: "Ⅱ", tone: "attention" },
      gapped: { label: "存在缺口", symbol: "!", tone: "danger" },
      stale: { label: "需要更新", symbol: "↻", tone: "attention" },
      partial: { label: "部分保存", symbol: "◐", tone: "partial" }
    };
    return table[status] || table.partial;
  }

  function getStats() {
    const conversations = [...state.conversations.values()];
    const stats = {
      conversationCount: conversations.length,
      messageCount: 0,
      complete: 0,
      partial: 0,
      attention: 0
    };
    for (const conversation of conversations) {
      stats.messageCount += archive.getMessageCount(conversation);
      const status = conversation.capture?.status || "partial";
      if (status === "complete") stats.complete += 1;
      else if (["gapped", "stale", "paused"].includes(status)) stats.attention += 1;
      else stats.partial += 1;
    }
    return stats;
  }

  function matchesStatusFilter(conversation, filter) {
    const status = conversation.capture?.status || "partial";
    if (filter === "all") return true;
    if (filter === "complete") return status === "complete";
    if (filter === "partial") return ["partial", "scanning"].includes(status);
    if (filter === "attention") return ["gapped", "stale", "paused"].includes(status);
    return true;
  }

  function render() {
    if (!ui.results) return;
    const stats = getStats();
    ui.footerStats.textContent = `${stats.conversationCount} 段对话 · ${stats.messageCount} 条消息`;
    ui.coverage.textContent = `${stats.complete} 个完整 · ${stats.partial} 个部分 · ${stats.attention} 个待处理`;
    ui.panel.dataset.view = state.activeView;
    ui.searchSection.hidden = state.activeView !== "search";
    ui.tabs.forEach((tab) => {
      tab.dataset.active = String(tab.dataset.view === state.activeView);
    });
    ui.filterButtons.forEach((button) => {
      button.dataset.active = String(button.dataset.filter === state.filterStatus);
    });
    renderCurrentConversation();
    renderPageStatus();
    renderScanHud();
    if (state.activeView === "library") renderLibrary();
    else renderSearch();
  }

  function renderCurrentConversation() {
    const id = getConversationId();
    const conversation = id ? state.conversations.get(id) : null;
    ui.currentCard.hidden = !id;
    if (!id) return;

    const meta = statusMeta(conversation?.capture?.status || "partial");
    const count = conversation ? archive.getMessageCount(conversation) : 0;
    ui.currentTitle.textContent = conversation?.title || document.title || "当前对话";
    ui.currentState.className = `cr-status-pill cr-tone-${meta.tone}`;
    ui.currentState.textContent = `${meta.symbol} ${meta.label} · ${count} 条`;
    ui.scanCurrent.textContent = conversation?.capture?.status === "complete"
      ? "重新校验"
      : conversation?.capture?.status === "paused"
        ? "继续完整扫描"
        : "扫描并完整保存";
    ui.scanCurrent.disabled = Boolean(state.capture?.active);
  }

  function renderPageStatus() {
    const id = getConversationId();
    const conversation = id ? state.conversations.get(id) : null;
    ui.pageStatus.hidden = !id || state.panelOpen;
    if (!id) return;
    const meta = statusMeta(conversation?.capture?.status || "partial");
    const count = conversation ? archive.getMessageCount(conversation) : 0;
    ui.pageStatus.className = `cr-page-status cr-tone-${meta.tone}`;
    ui.pageStatus.textContent = `${meta.symbol} ${meta.label} · ${count} 条`;
  }

  function renderSearch() {
    const query = state.searchQuery.trim();
    const stats = getStats();
    if (!query) {
      state.lastResults = [];
      ui.results.innerHTML = `
        <div class="cr-empty">
          <div>
            <strong>${stats.conversationCount ? "本地记忆已经就位" : "从这一页开始记住"}</strong>
            <span>${stats.conversationCount
              ? `当前可检索 ${stats.complete} 个完整对话；部分记录仍可能遗漏未加载内容。`
              : "打开任意历史对话，或开始一段新对话；消息会增量加入本地档案。"}</span>
          </div>
        </div>`;
      return;
    }

    const allowed = new Set(
      [...state.conversations.values()]
        .filter((conversation) => matchesStatusFilter(conversation, state.filterStatus))
        .map((conversation) => conversation.id)
    );
    const results = searchCore.searchConversations(
      [...state.conversations.values()],
      query,
      MAX_RESULTS * 2
    ).filter((result) => allowed.has(result.conversationId)).slice(0, MAX_RESULTS);
    state.lastResults = results;

    if (!results.length) {
      const warning = stats.partial + stats.attention > 0
        ? `仍有 ${stats.partial + stats.attention} 个对话未完整收录，不能确定原对话中不存在该内容。`
        : "所有已收录对话均已搜索。";
      ui.results.innerHTML = `
        <div class="cr-empty">
          <div>
            <strong>本地记录中没有找到</strong>
            <span>${escapeHtml(warning)}</span>
          </div>
        </div>`;
      return;
    }

    ui.results.innerHTML = results.map((result, index) => {
      const meta = statusMeta(result.captureStatus);
      const position = result.captureStatus === "complete"
        ? `第 ${result.messageIndex + 1} / ${result.messageCount} 条`
        : `本地共 ${result.messageCount} 条`;
      return `
        <article class="cr-result">
          <button class="cr-result-main" type="button" data-preview-index="${index}">
            <div class="cr-result-meta">
              <span class="cr-status-pill cr-tone-${meta.tone}">${meta.symbol} ${meta.label}</span>
              <span>${result.role === "user" ? "你" : "GPT"}</span>
              <span>${escapeHtml(position)}</span>
            </div>
            <p class="cr-result-title">${highlight(result.title, query)}</p>
            <p class="cr-snippet">${highlight(result.snippet, query)}</p>
          </button>
          <button class="cr-result-locate" type="button" data-locate-index="${index}">在 ChatGPT 中定位</button>
        </article>`;
    }).join("");
  }

  function renderLibrary() {
    const priority = { gapped: 0, stale: 1, paused: 2, partial: 3, scanning: 4, complete: 5 };
    const conversations = [...state.conversations.values()]
      .sort((left, right) => {
        const statusDifference = (priority[left.capture?.status] ?? 3)
          - (priority[right.capture?.status] ?? 3);
        return statusDifference || right.updatedAt - left.updatedAt;
      });

    if (!conversations.length) {
      ui.results.innerHTML = `
        <div class="cr-empty"><div><strong>收录库还是空的</strong><span>打开一段对话后便会开始累积保存。</span></div></div>`;
      return;
    }

    const currentId = getConversationId();
    ui.results.innerHTML = conversations.map((conversation) => {
      const meta = statusMeta(conversation.capture?.status);
      const count = archive.getMessageCount(conversation);
      const detail = conversation.capture?.status === "complete"
        ? `完整保存于 ${formatDate(conversation.capture.completedAt)}`
        : conversation.capture?.hasGaps
          ? `${conversation.capture.segmentCount} 个区段 · 顺序尚未连通`
          : `最后收录于 ${formatDate(conversation.updatedAt)}`;
      return `
        <article class="cr-library-card">
          <div class="cr-library-head">
            <span class="cr-status-pill cr-tone-${meta.tone}">${meta.symbol} ${meta.label}</span>
            <span>${count} 条</span>
          </div>
          <h3>${escapeHtml(conversation.title)}</h3>
          <p>${escapeHtml(detail)}</p>
          <div class="cr-library-actions">
            <button type="button" data-open-conversation="${escapeHtml(conversation.id)}">打开对话</button>
            ${conversation.id === currentId
              ? `<button class="cr-primary-link" type="button" data-scan-conversation="${escapeHtml(conversation.id)}">${conversation.capture?.status === "complete" ? "重新校验" : "完整扫描"}</button>`
              : ""}
          </div>
        </article>`;
    }).join("");
  }

  function showLocalPreview(result) {
    const conversation = state.conversations.get(result.conversationId);
    const message = archive.getMessages(conversation)
      .find((item) => item.id === result.messageId);
    if (!message) return;
    ui.viewerTitle.textContent = conversation.title;
    ui.viewerMeta.textContent = `${message.role === "user" ? "你" : "GPT"} · 本地存档`;
    ui.viewerText.textContent = message.text;
    ui.viewer.dataset.show = "true";
    ui.viewerLocate.dataset.conversationId = conversation.id;
    ui.viewerLocate.dataset.messageId = message.id;
  }

  function closeLocalPreview() {
    ui.viewer.dataset.show = "false";
  }

  async function openResult(result) {
    await chrome.storage.local.set({
      [PENDING_JUMP_KEY]: {
        conversationId: result.conversationId,
        messageId: result.messageId,
        stableId: result.stableId,
        messageIndex: result.messageIndex,
        expiresAt: Date.now() + 5 * 60_000
      }
    });

    if (getConversationId() === result.conversationId) {
      await attemptPendingJump(result.conversationId);
      return;
    }
    location.assign(result.url);
  }

  function findScrollContainer(node) {
    let current = node?.parentElement;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        current.scrollHeight > current.clientHeight + 20
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function isDocumentScroller(container) {
    return container === document.scrollingElement
      || container === document.documentElement
      || container === document.body;
  }

  function getScrollMetrics(container) {
    if (isDocumentScroller(container)) {
      const root = document.scrollingElement || document.documentElement;
      return {
        top: root.scrollTop,
        height: window.innerHeight,
        scrollHeight: root.scrollHeight
      };
    }
    return {
      top: container.scrollTop,
      height: container.clientHeight,
      scrollHeight: container.scrollHeight
    };
  }

  function setScrollPosition(container, top, behavior = "auto") {
    if (isDocumentScroller(container)) window.scrollTo({ top, behavior });
    else container.scrollTo({ top, behavior });
  }

  function scrollElementToCenter(element) {
    const container = findScrollContainer(element);
    const targetRect = element.getBoundingClientRect();
    if (isDocumentScroller(container)) {
      const root = document.scrollingElement || document.documentElement;
      const top = root.scrollTop + targetRect.top - window.innerHeight / 2 + targetRect.height / 2;
      window.scrollTo({ top, behavior: "smooth" });
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const top = container.scrollTop
      + targetRect.top
      - containerRect.top
      - container.clientHeight / 2
      + targetRect.height / 2;
    container.scrollTo({ top, behavior: "smooth" });
  }

  async function attemptPendingJump(conversationId) {
    const stored = await chrome.storage.local.get(PENDING_JUMP_KEY);
    const pending = stored[PENDING_JUMP_KEY];
    if (!pending || pending.conversationId !== conversationId) return;
    if (pending.expiresAt < Date.now()) {
      await chrome.storage.local.remove(PENDING_JUMP_KEY);
      return;
    }

    const observed = extractMessages();
    let targetRecord = pending.stableId
      ? observed.find((item) => item.stableId === pending.stableId)
      : null;
    if (!targetRecord) {
      const conversation = state.conversations.get(conversationId);
      const storedMessage = archive.getMessages(conversation)
        .find((message) => message.id === pending.messageId);
      if (storedMessage) {
        const normalized = archive.normalizeText(storedMessage.text);
        targetRecord = observed.find((item) =>
          item.role === storedMessage.role &&
          archive.normalizeText(item.text) === normalized
        );
      }
    }
    if (!targetRecord) {
      showToast("消息已保存在本地，但当前网页尚未加载到该楼层");
      return;
    }

    const turn = targetRecord.node.closest("article") || targetRecord.node;
    scrollElementToCenter(turn);
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

  function openCaptureConfirm() {
    const id = getConversationId();
    if (!id) {
      showToast("请先打开一段 ChatGPT 对话");
      return;
    }
    if (document.querySelector('[data-testid="stop-button"]')) {
      showToast("请等待当前回复生成完成后再扫描");
      return;
    }
    ui.captureConfirm.dataset.show = "true";
  }

  function closeCaptureConfirm() {
    ui.captureConfirm.dataset.show = "false";
  }

  async function setConversationCaptureStatus(id, status, patch = {}) {
    const conversation = state.conversations.get(id);
    if (!conversation) return;
    const updated = archive.setCaptureStatus(conversation, status, patch);
    await persistConversation(updated);
  }

  function captureReliability() {
    if (!state.capture?.observedCount) return "unknown";
    return state.capture.stableObservedCount === state.capture.observedCount
      ? "strong"
      : "limited";
  }

  async function startFullCapture() {
    closeCaptureConfirm();
    if (state.capture?.active) return;
    const id = getConversationId();
    const observed = extractMessages();
    if (!id || !observed.length) {
      showToast("当前对话内容尚未加载");
      return;
    }

    await harvestConversation({ immediate: true, force: true });
    const container = findScrollContainer(observed[0].node);
    const metrics = getScrollMetrics(container);
    state.capture = {
      active: true,
      paused: false,
      cancelled: false,
      conversationId: id,
      container,
      originalTop: metrics.top,
      phase: "正在定位顶部",
      note: "请保持此标签页在前台",
      newCount: 0,
      updatedCount: 0,
      observedCount: 0,
      stableObservedCount: 0,
      topReached: false,
      bottomReached: false,
      startedAt: Date.now(),
      outcome: null
    };
    await setConversationCaptureStatus(id, "scanning", {
      lastScanAt: Date.now(),
      topReached: false,
      bottomReached: false,
      orderConflict: false
    });
    render();
    runFullCapture().catch(async () => {
      if (state.capture) {
        state.capture.active = false;
        state.capture.outcome = "error";
        state.capture.note = "扫描发生错误，已保存此前发现的消息";
        await setConversationCaptureStatus(id, "paused");
        render();
      }
    });
  }

  async function waitWhilePaused() {
    while (state.capture?.active && state.capture.paused) await wait(250);
    return Boolean(state.capture?.active);
  }

  function updateCapturePhase(phase, note) {
    if (!state.capture) return;
    state.capture.phase = phase;
    if (note) state.capture.note = note;
    renderScanHud();
  }

  async function settleBoundary(container, boundary, maxAttempts = 16) {
    let stableCycles = 0;
    let previousSignature = "";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!await waitWhilePaused()) return false;
      const metrics = getScrollMetrics(container);
      const target = boundary === "top"
        ? 0
        : Math.max(0, metrics.scrollHeight - metrics.height);
      setScrollPosition(container, target, attempt === 0 ? "smooth" : "auto");
      await wait(650);
      await harvestConversation({ immediate: true, force: true });
      const current = getScrollMetrics(container);
      const signature = `${Math.round(current.top)}:${current.scrollHeight}:${extractMessages().length}`;
      if (signature === previousSignature) stableCycles += 1;
      else stableCycles = 0;
      previousSignature = signature;
      const reached = boundary === "top"
        ? current.top <= 4
        : current.top + current.height >= current.scrollHeight - 8;
      if (reached && stableCycles >= 2) return true;
    }
    return false;
  }

  async function runFullCapture() {
    const capture = state.capture;
    const { container, conversationId } = capture;

    updateCapturePhase("正在定位顶部", "等待顶部消息稳定加载");
    capture.topReached = await settleBoundary(container, "top");
    if (!capture.active) return finishInterruptedCapture();

    updateCapturePhase("正在向下收录", "每一批消息都会立即累积保存");
    let loopCount = 0;
    let stagnantCycles = 0;
    while (capture.active && loopCount < 900) {
      loopCount += 1;
      if (!await waitWhilePaused()) return finishInterruptedCapture();
      const before = getScrollMetrics(container);
      await harvestConversation({ immediate: true, force: true });
      const atBottom = before.top + before.height >= before.scrollHeight - 8;
      if (atBottom) break;

      const step = Math.max(280, Math.floor(before.height * 0.68));
      setScrollPosition(container, Math.min(before.top + step, before.scrollHeight), "smooth");
      await wait(720);
      const after = getScrollMetrics(container);
      if (after.top <= before.top + 2 && after.scrollHeight === before.scrollHeight) stagnantCycles += 1;
      else stagnantCycles = 0;
      if (stagnantCycles >= 5) break;
    }

    if (!capture.active) return finishInterruptedCapture();
    updateCapturePhase("正在确认底部", "等待最后一批消息稳定加载");
    capture.bottomReached = await settleBoundary(container, "bottom");
    if (!capture.active) return finishInterruptedCapture();

    updateCapturePhase("正在校验顺序", "检查顶部、底部与消息区段");
    await harvestConversation({ immediate: true, force: true });
    const conversation = state.conversations.get(conversationId);
    const finalized = archive.finalizeCapture(conversation, {
      topReached: capture.topReached,
      bottomReached: capture.bottomReached,
      reliability: captureReliability()
    });
    await persistConversation(finalized);

    capture.active = false;
    capture.outcome = finalized.capture.status === "complete" ? "complete" : "incomplete";
    capture.phase = capture.outcome === "complete" ? "当前分支已完整保存" : "扫描完成，但仍存在缺口";
    capture.note = capture.outcome === "complete"
      ? `${archive.getMessageCount(finalized)} 条消息 · ${finalized.capture.reliability === "strong" ? "顺序校验通过" : "顺序校验能力有限"}`
      : `${finalized.capture.segmentCount} 个区段尚未完全连通`;
    restoreOriginalPosition(capture);
    render();
    showToast(capture.outcome === "complete" ? "当前对话已完整保存" : "已保留扫描结果，建议再次扫描缺口");
  }

  async function finishInterruptedCapture() {
    const capture = state.capture;
    if (!capture) return;
    const conversation = state.conversations.get(capture.conversationId);
    if (conversation) {
      const status = conversation.capture?.hasGaps ? "gapped" : "paused";
      await persistConversation(archive.setCaptureStatus(conversation, status, {
        lastScanAt: Date.now(),
        topReached: capture.topReached,
        bottomReached: capture.bottomReached
      }));
    }
    capture.active = false;
    capture.outcome = "paused";
    capture.phase = "扫描已停止";
    capture.note = "此前发现的消息已经保存，可稍后继续";
    restoreOriginalPosition(capture);
    render();
  }

  function restoreOriginalPosition(capture) {
    wait(250).then(() => {
      const metrics = getScrollMetrics(capture.container);
      setScrollPosition(
        capture.container,
        Math.min(capture.originalTop, Math.max(0, metrics.scrollHeight - metrics.height)),
        "smooth"
      );
    });
  }

  function pauseFullCapture(reason = "扫描已暂停") {
    if (!state.capture?.active || state.capture.paused) return;
    state.capture.paused = true;
    state.capture.phase = "扫描已暂停";
    state.capture.note = reason;
    setConversationCaptureStatus(state.capture.conversationId, "paused").catch(() => {});
    render();
  }

  function resumeFullCapture() {
    if (!state.capture?.active || !state.capture.paused) return;
    state.capture.paused = false;
    state.capture.phase = "正在继续扫描";
    state.capture.note = "请保持此标签页在前台";
    setConversationCaptureStatus(state.capture.conversationId, "scanning").catch(() => {});
    render();
  }

  function stopFullCapture() {
    if (!state.capture?.active) return;
    state.capture.cancelled = true;
    state.capture.active = false;
    state.capture.paused = false;
  }

  function renderScanHud() {
    const capture = state.capture;
    ui.scanHud.dataset.show = String(Boolean(capture));
    if (!capture) return;
    const conversation = state.conversations.get(capture.conversationId);
    ui.hudTitle.textContent = conversation?.title || "当前对话";
    ui.hudPhase.textContent = capture.phase;
    ui.hudNote.textContent = capture.note;
    ui.hudNew.textContent = String(capture.newCount);
    ui.hudTotal.textContent = String(conversation ? archive.getMessageCount(conversation) : 0);
    ui.hudSegments.textContent = String(conversation?.capture?.segmentCount || 0);
    ui.hudGaps.textContent = conversation?.capture?.hasGaps ? "有" : "暂未发现";
    ui.hudPause.hidden = !capture.active;
    ui.hudPause.textContent = capture.paused ? "继续" : "暂停";
    ui.hudStop.hidden = !capture.active;
    ui.hudClose.hidden = capture.active;
    ui.scanHud.dataset.outcome = capture.outcome || "running";
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
    scheduleHarvest();
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
      ![1, 2].includes(backup?.version) ||
      !Array.isArray(backup.conversations)
    ) {
      showToast("无法读取备份：格式或版本不兼容");
      return;
    }

    let restored = 0;
    for (const raw of backup.conversations) {
      const incoming = archive.migrateConversation(raw);
      if (!incoming?.id) continue;
      const existing = state.conversations.get(incoming.id);
      if (!existing || (incoming.updatedAt || 0) >= (existing.updatedAt || 0)) {
        state.conversations.set(incoming.id, incoming);
        restored += 1;
      }
    }
    try {
      await persistAllConversations();
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
    }, 2600);
  }

  function setPanelOpen(open) {
    state.panelOpen = open;
    ui.panel.dataset.open = String(open);
    ui.launcher.hidden = open;
    renderPageStatus();
    if (open && state.activeView === "search") setTimeout(() => ui.search.focus(), 80);
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
    <button class="cr-page-status" type="button" hidden></button>
    <aside class="cr-panel" data-open="false" data-view="search" aria-label="ChatGPT 对话搜索">
      <header class="cr-header">
        <div>
          <p class="cr-eyebrow">LOCAL CONVERSATION ARCHIVE</p>
          <h2 class="cr-title">对话寻踪</h2>
        </div>
        <button class="cr-icon-button cr-close" type="button" title="关闭" aria-label="关闭">✕</button>
      </header>
      <nav class="cr-tabs" aria-label="功能">
        <button type="button" data-view="search" data-active="true">搜索</button>
        <button type="button" data-view="library" data-active="false">收录库</button>
        <span class="cr-coverage">0 个完整 · 0 个部分 · 0 个待处理</span>
      </nav>
      <section class="cr-current-card" hidden>
        <div>
          <p class="cr-current-label">当前对话</p>
          <strong class="cr-current-title"></strong>
          <span class="cr-current-state cr-status-pill"></span>
        </div>
        <button class="cr-scan-current" type="button">扫描并完整保存</button>
      </section>
      <section class="cr-search-section">
        <div class="cr-search-wrap">
          <svg class="cr-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="m16 16 4 4"></path>
          </svg>
          <input class="cr-search" type="search" autocomplete="off" placeholder="搜索本地对话档案…" />
          <span class="cr-shortcut">Alt K</span>
        </div>
        <div class="cr-filters">
          <button type="button" data-filter="all" data-active="true">全部</button>
          <button type="button" data-filter="complete">已完整</button>
          <button type="button" data-filter="partial">部分</button>
          <button type="button" data-filter="attention">待处理</button>
        </div>
      </section>
      <div class="cr-status"><span class="cr-dot"></span><span class="cr-status-text">正在初始化本地档案…</span></div>
      <div class="cr-results"></div>
      <footer class="cr-footer">
        <span class="cr-footer-stats">0 段对话 · 0 条消息</span>
        <div class="cr-footer-actions">
          <button class="cr-footer-button cr-export" type="button">备份</button>
          <button class="cr-footer-button cr-import" type="button">恢复</button>
          <button class="cr-footer-button cr-clear" type="button">清空</button>
        </div>
        <span class="cr-backup-note">消息只增不减地保存在本机；完整状态会标明搜索可信范围。</span>
        <input class="cr-file-input" type="file" accept=".json,application/json" hidden />
      </footer>
    </aside>
    <aside class="cr-scan-hud" data-show="false" data-outcome="running" aria-live="polite">
      <div class="cr-hud-kicker">完整收录</div>
      <strong class="cr-hud-title">当前对话</strong>
      <h3 class="cr-hud-phase">正在准备</h3>
      <p class="cr-hud-note">请保持此标签页在前台</p>
      <dl class="cr-hud-stats">
        <div><dt>本次新发现</dt><dd class="cr-hud-new">0</dd></div>
        <div><dt>本地总计</dt><dd class="cr-hud-total">0</dd></div>
        <div><dt>连续区段</dt><dd class="cr-hud-segments">0</dd></div>
        <div><dt>顺序缺口</dt><dd class="cr-hud-gaps">暂未发现</dd></div>
      </dl>
      <div class="cr-hud-actions">
        <button class="cr-hud-pause" type="button">暂停</button>
        <button class="cr-hud-stop" type="button">停止并保留</button>
        <button class="cr-hud-close" type="button" hidden>关闭</button>
      </div>
    </aside>
    <div class="cr-modal cr-capture-confirm" data-show="false">
      <div class="cr-modal-card" role="dialog" aria-modal="true" aria-labelledby="cr-confirm-title">
        <p class="cr-eyebrow">FULL CAPTURE</p>
        <h2 id="cr-confirm-title">扫描并完整保存当前对话？</h2>
        <p>插件将先返回顶部，再分段向下滚动并累积保存。请保持标签页在前台；手动滚动会暂停扫描。完成后会尽量恢复当前阅读位置。</p>
        <div class="cr-modal-actions">
          <button class="cr-confirm-cancel" type="button">取消</button>
          <button class="cr-confirm-start cr-primary-button" type="button">开始扫描</button>
        </div>
      </div>
    </div>
    <div class="cr-modal cr-viewer" data-show="false">
      <div class="cr-modal-card cr-viewer-card" role="dialog" aria-modal="true">
        <button class="cr-viewer-close cr-icon-button" type="button" aria-label="关闭">✕</button>
        <p class="cr-viewer-meta"></p>
        <h2 class="cr-viewer-title"></h2>
        <pre class="cr-viewer-text"></pre>
        <button class="cr-viewer-locate cr-primary-button" type="button">在 ChatGPT 中定位</button>
      </div>
    </div>
    <div class="cr-toast" data-show="false"></div>`;
  shadow.appendChild(root);

  const ui = {
    launcher: root.querySelector(".cr-launcher"),
    pageStatus: root.querySelector(".cr-page-status"),
    panel: root.querySelector(".cr-panel"),
    close: root.querySelector(".cr-close"),
    tabs: [...root.querySelectorAll(".cr-tabs [data-view]")],
    coverage: root.querySelector(".cr-coverage"),
    currentCard: root.querySelector(".cr-current-card"),
    currentTitle: root.querySelector(".cr-current-title"),
    currentState: root.querySelector(".cr-current-state"),
    scanCurrent: root.querySelector(".cr-scan-current"),
    searchSection: root.querySelector(".cr-search-section"),
    search: root.querySelector(".cr-search"),
    filterButtons: [...root.querySelectorAll(".cr-filters [data-filter]")],
    statusText: root.querySelector(".cr-status-text"),
    results: root.querySelector(".cr-results"),
    footerStats: root.querySelector(".cr-footer-stats"),
    export: root.querySelector(".cr-export"),
    import: root.querySelector(".cr-import"),
    clear: root.querySelector(".cr-clear"),
    fileInput: root.querySelector(".cr-file-input"),
    scanHud: root.querySelector(".cr-scan-hud"),
    hudTitle: root.querySelector(".cr-hud-title"),
    hudPhase: root.querySelector(".cr-hud-phase"),
    hudNote: root.querySelector(".cr-hud-note"),
    hudNew: root.querySelector(".cr-hud-new"),
    hudTotal: root.querySelector(".cr-hud-total"),
    hudSegments: root.querySelector(".cr-hud-segments"),
    hudGaps: root.querySelector(".cr-hud-gaps"),
    hudPause: root.querySelector(".cr-hud-pause"),
    hudStop: root.querySelector(".cr-hud-stop"),
    hudClose: root.querySelector(".cr-hud-close"),
    captureConfirm: root.querySelector(".cr-capture-confirm"),
    confirmCancel: root.querySelector(".cr-confirm-cancel"),
    confirmStart: root.querySelector(".cr-confirm-start"),
    viewer: root.querySelector(".cr-viewer"),
    viewerClose: root.querySelector(".cr-viewer-close"),
    viewerTitle: root.querySelector(".cr-viewer-title"),
    viewerMeta: root.querySelector(".cr-viewer-meta"),
    viewerText: root.querySelector(".cr-viewer-text"),
    viewerLocate: root.querySelector(".cr-viewer-locate"),
    toast: root.querySelector(".cr-toast")
  };

  ui.launcher.addEventListener("click", () => setPanelOpen(true));
  ui.pageStatus.addEventListener("click", () => setPanelOpen(true));
  ui.close.addEventListener("click", () => setPanelOpen(false));
  ui.tabs.forEach((tab) => tab.addEventListener("click", () => {
    state.activeView = tab.dataset.view;
    render();
  }));
  ui.search.addEventListener("input", debounce(() => {
    state.searchQuery = ui.search.value;
    render();
  }, 80));
  ui.filterButtons.forEach((button) => button.addEventListener("click", () => {
    state.filterStatus = button.dataset.filter;
    render();
  }));
  ui.scanCurrent.addEventListener("click", openCaptureConfirm);
  ui.confirmCancel.addEventListener("click", closeCaptureConfirm);
  ui.confirmStart.addEventListener("click", startFullCapture);
  ui.hudPause.addEventListener("click", () => {
    if (state.capture?.paused) resumeFullCapture();
    else pauseFullCapture("由用户暂停，可随时继续");
  });
  ui.hudStop.addEventListener("click", stopFullCapture);
  ui.hudClose.addEventListener("click", () => {
    state.capture = null;
    render();
  });
  ui.viewerClose.addEventListener("click", closeLocalPreview);
  ui.viewerLocate.addEventListener("click", () => {
    const conversation = state.conversations.get(ui.viewerLocate.dataset.conversationId);
    const message = archive.getMessages(conversation)
      .find((item) => item.id === ui.viewerLocate.dataset.messageId);
    if (!conversation || !message) return;
    closeLocalPreview();
    openResult({
      conversationId: conversation.id,
      url: conversation.url,
      messageId: message.id,
      stableId: message.stableId,
      messageIndex: archive.getMessages(conversation).findIndex((item) => item.id === message.id)
    });
  });
  ui.results.addEventListener("click", (event) => {
    const preview = event.target.closest("[data-preview-index]");
    const locate = event.target.closest("[data-locate-index]");
    const openConversation = event.target.closest("[data-open-conversation]");
    const scanConversation = event.target.closest("[data-scan-conversation]");
    if (preview) showLocalPreview(state.lastResults[Number(preview.dataset.previewIndex)]);
    if (locate) openResult(state.lastResults[Number(locate.dataset.locateIndex)]);
    if (openConversation) {
      const conversation = state.conversations.get(openConversation.dataset.openConversation);
      if (conversation) location.assign(conversation.url);
    }
    if (scanConversation) openCaptureConfirm();
  });
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
      return;
    }
    if (event.key === "Escape" && state.panelOpen) setPanelOpen(false);
    if (
      state.capture?.active &&
      !state.capture.paused &&
      event.target !== host &&
      ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
    ) {
      pauseFullCapture("检测到手动操作，扫描已暂停");
    }
  }, true);

  document.addEventListener("wheel", () => {
    if (state.capture?.active && !state.capture.paused) {
      pauseFullCapture("检测到手动滚动，扫描已暂停");
    }
  }, { capture: true, passive: true });
  document.addEventListener("touchstart", () => {
    if (state.capture?.active && !state.capture.paused) {
      pauseFullCapture("检测到触控操作，扫描已暂停");
    }
  }, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.capture?.active && !state.capture.paused) {
      pauseFullCapture("标签页进入后台，扫描已暂停");
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "CHAT_RECALL_TOGGLE") setPanelOpen(!state.panelOpen);
  });

  const observer = new MutationObserver(scheduleHarvest);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      if (state.capture?.active) stopFullCapture();
      lastUrl = location.href;
      state.lastFingerprint = "";
      state.currentConversationId = getConversationId();
      scheduleHarvest();
      render();
    }
  }, 800);

  loadIndex()
    .then(() => {
      scheduleHarvest();
      setStatus("打开一段对话后便会开始增量收录");
    })
    .catch(() => setStatus("无法读取本地档案，请重新加载扩展"));
})();
