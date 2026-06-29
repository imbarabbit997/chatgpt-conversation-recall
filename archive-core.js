(function exposeArchiveCore(globalScope) {
  "use strict";

  const SCHEMA_VERSION = 2;

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hashString(value) {
    let hash = 2166136261;
    const source = String(value ?? "");
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function signature(message) {
    return `${message.role}\u241f${normalizeText(message.text)}`;
  }

  function createMessageId(message, now, serial) {
    if (message.stableId) return `stable:${message.stableId}`;
    return `local:${hashString(signature(message))}:${now.toString(36)}:${serial}`;
  }

  function defaultCapture(status = "partial") {
    return {
      status,
      completedAt: null,
      lastScanAt: null,
      topReached: false,
      bottomReached: false,
      segmentCount: 0,
      hasGaps: false,
      orderConflict: false,
      reliability: "unknown",
      messageCount: 0
    };
  }

  function createConversation(meta = {}, now = Date.now()) {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: meta.id,
      title: meta.title || "未命名对话",
      url: meta.url || "",
      createdAt: meta.createdAt || now,
      updatedAt: meta.updatedAt || now,
      segments: [],
      capture: defaultCapture("partial")
    };
  }

  function getMessages(conversation) {
    if (Array.isArray(conversation?.segments)) {
      const seen = new Set();
      const messages = [];
      for (const segment of conversation.segments) {
        for (const message of segment.messages || []) {
          if (!seen.has(message.id)) {
            seen.add(message.id);
            messages.push(message);
          }
        }
      }
      return messages;
    }
    return Array.isArray(conversation?.messages) ? conversation.messages : [];
  }

  function getMessageCount(conversation) {
    return getMessages(conversation).length;
  }

  function migrateConversation(record, now = Date.now()) {
    if (!record || typeof record !== "object") return null;
    if (record.schemaVersion === SCHEMA_VERSION && Array.isArray(record.segments)) {
      record.capture = { ...defaultCapture(), ...(record.capture || {}) };
      record.segments.forEach((segment, index) => {
        segment.id ||= `segment:migrated:${index}`;
        segment.messages ||= [];
      });
      refreshCaptureStats(record);
      return record;
    }

    if (!record.id || !Array.isArray(record.messages)) return null;
    const conversation = createConversation(record, now);
    const messages = record.messages
      .filter((message) => message && message.text && message.role)
      .map((message, index) => {
        const stableId = message.id && !String(message.id).startsWith("position-")
          ? String(message.id).replace(/^stable:/, "")
          : null;
        return {
          id: stableId ? `stable:${stableId}` : createMessageId(message, now, index),
          stableId,
          role: message.role,
          text: String(message.text),
          firstSeenAt: record.createdAt || now,
          lastSeenAt: record.updatedAt || now,
          revision: 1
        };
      });
    if (messages.length) {
      conversation.segments.push({
        id: `segment:migrated:${hashString(record.id)}`,
        messages
      });
    }
    conversation.capture = {
      ...defaultCapture("partial"),
      reliability: messages.every((message) => message.stableId) ? "strong" : "limited"
    };
    refreshCaptureStats(conversation);
    return conversation;
  }

  function buildMessageMaps(conversation) {
    const byId = new Map();
    const byStableId = new Map();
    const bySignature = new Map();
    const segmentByMessageId = new Map();

    conversation.segments.forEach((segment, segmentIndex) => {
      for (const message of segment.messages) {
        byId.set(message.id, message);
        if (message.stableId) byStableId.set(message.stableId, message);
        const key = signature(message);
        if (!bySignature.has(key)) bySignature.set(key, []);
        bySignature.get(key).push(message);
        segmentByMessageId.set(message.id, segmentIndex);
      }
    });
    return { byId, byStableId, bySignature, segmentByMessageId };
  }

  function topologicalMerge(sequences, messagesById) {
    const nodeOrder = new Map();
    const edges = new Map();
    const indegree = new Map();
    let priority = 0;

    for (const sequence of sequences) {
      for (const id of sequence) {
        if (!nodeOrder.has(id)) nodeOrder.set(id, priority++);
        if (!edges.has(id)) edges.set(id, new Set());
        if (!indegree.has(id)) indegree.set(id, 0);
      }
      for (let index = 0; index < sequence.length - 1; index += 1) {
        const from = sequence[index];
        const to = sequence[index + 1];
        if (from === to || edges.get(from).has(to)) continue;
        edges.get(from).add(to);
        indegree.set(to, (indegree.get(to) || 0) + 1);
      }
    }

    const ready = [...indegree.entries()]
      .filter(([, degree]) => degree === 0)
      .map(([id]) => id)
      .sort((left, right) => nodeOrder.get(left) - nodeOrder.get(right));
    const sorted = [];

    while (ready.length) {
      const id = ready.shift();
      sorted.push(id);
      for (const target of edges.get(id) || []) {
        const degree = indegree.get(target) - 1;
        indegree.set(target, degree);
        if (degree === 0) {
          ready.push(target);
          ready.sort((left, right) => nodeOrder.get(left) - nodeOrder.get(right));
        }
      }
    }

    const conflict = sorted.length !== indegree.size;
    if (conflict) {
      const fallback = [];
      const seen = new Set();
      for (const sequence of sequences) {
        for (const id of sequence) {
          if (!seen.has(id)) {
            seen.add(id);
            fallback.push(id);
          }
        }
      }
      return {
        conflict: true,
        messages: fallback.map((id) => messagesById.get(id)).filter(Boolean)
      };
    }

    return {
      conflict: false,
      messages: sorted.map((id) => messagesById.get(id)).filter(Boolean)
    };
  }

  function refreshCaptureStats(conversation) {
    const capture = conversation.capture || defaultCapture();
    capture.segmentCount = conversation.segments.length;
    capture.hasGaps = conversation.segments.length > 1 || Boolean(capture.orderConflict);
    capture.messageCount = getMessageCount(conversation);
    conversation.capture = capture;
    return conversation;
  }

  function mergeObservation(record, observed, meta = {}, options = {}) {
    const now = options.now || Date.now();
    const conversation = migrateConversation(record, now)
      || createConversation(meta, now);
    conversation.title = meta.title || conversation.title;
    conversation.url = meta.url || conversation.url;
    conversation.updatedAt = now;

    const cleanObserved = (observed || [])
      .filter((message) => message && message.text && ["user", "assistant"].includes(message.role))
      .map((message) => ({
        stableId: message.stableId || null,
        role: message.role,
        text: String(message.text)
      }));

    if (!cleanObserved.length) {
      return { conversation: refreshCaptureStats(conversation), newCount: 0, updatedCount: 0 };
    }

    const maps = buildMessageMaps(conversation);
    const claimed = new Set();
    const resolved = [];
    let newCount = 0;
    let updatedCount = 0;
    let stableCount = 0;

    cleanObserved.forEach((observedMessage, serial) => {
      let existing = observedMessage.stableId
        ? maps.byStableId.get(observedMessage.stableId)
        : null;
      if (observedMessage.stableId) stableCount += 1;

      if (!existing) {
        const candidates = maps.bySignature.get(signature(observedMessage)) || [];
        existing = candidates.find((candidate) => !claimed.has(candidate.id)) || null;
      }

      if (!existing && !observedMessage.stableId) {
        const incoming = normalizeText(observedMessage.text);
        const prefixCandidates = [...maps.byId.values()]
          .filter((candidate) => {
            if (claimed.has(candidate.id) || candidate.role !== observedMessage.role) return false;
            const stored = normalizeText(candidate.text);
            const sharedLength = Math.min(stored.length, incoming.length);
            return sharedLength >= 24 && (stored.startsWith(incoming) || incoming.startsWith(stored));
          })
          .sort((left, right) => right.text.length - left.text.length);
        if (prefixCandidates.length === 1) existing = prefixCandidates[0];
      }

      if (existing) {
        claimed.add(existing.id);
        const incomingText = normalizeText(observedMessage.text);
        const storedText = normalizeText(existing.text);
        if (
          incomingText !== storedText &&
          (observedMessage.stableId || incomingText.length >= storedText.length)
        ) {
          existing.text = observedMessage.text;
          existing.revision = (existing.revision || 1) + 1;
          updatedCount += 1;
        }
        if (observedMessage.stableId && !existing.stableId) {
          existing.stableId = observedMessage.stableId;
        }
        existing.lastSeenAt = now;
        resolved.push(existing);
        return;
      }

      const created = {
        id: createMessageId(observedMessage, now, serial),
        stableId: observedMessage.stableId,
        role: observedMessage.role,
        text: observedMessage.text,
        firstSeenAt: now,
        lastSeenAt: now,
        revision: 1
      };
      claimed.add(created.id);
      maps.byId.set(created.id, created);
      if (created.stableId) maps.byStableId.set(created.stableId, created);
      resolved.push(created);
      newCount += 1;
    });

    const touchedIndexes = [...new Set(
      resolved
        .map((message) => maps.segmentByMessageId.get(message.id))
        .filter((index) => Number.isInteger(index))
    )].sort((left, right) => left - right);

    if (!touchedIndexes.length) {
      conversation.segments.push({
        id: `segment:${now.toString(36)}:${hashString(resolved.map((item) => item.id).join("|"))}`,
        messages: resolved
      });
    } else {
      const touchedSegments = touchedIndexes.map((index) => conversation.segments[index]);
      const messagesById = new Map();
      for (const segment of touchedSegments) {
        for (const message of segment.messages) messagesById.set(message.id, message);
      }
      for (const message of resolved) messagesById.set(message.id, message);

      const sequences = [
        ...touchedSegments.map((segment) => segment.messages.map((message) => message.id)),
        resolved.map((message) => message.id)
      ];
      const merged = topologicalMerge(sequences, messagesById);
      const insertAt = touchedIndexes[0];
      conversation.segments = conversation.segments.filter((_, index) => !touchedIndexes.includes(index));
      conversation.segments.splice(insertAt, 0, {
        id: touchedSegments[0].id,
        messages: merged.messages
      });
      if (merged.conflict) conversation.capture.orderConflict = true;
    }

    if (
      (newCount > 0 || updatedCount > 0) &&
      conversation.capture.status === "complete" &&
      !options.captureActive
    ) {
      conversation.capture.status = "stale";
    } else if (!["scanning", "paused", "complete", "stale"].includes(conversation.capture.status)) {
      conversation.capture.status = conversation.segments.length > 1 ? "gapped" : "partial";
    }

    conversation.capture.reliability = stableCount === cleanObserved.length
      ? "strong"
      : "limited";
    refreshCaptureStats(conversation);
    return { conversation, newCount, updatedCount };
  }

  function setCaptureStatus(record, status, patch = {}) {
    const conversation = migrateConversation(record) || record;
    conversation.capture = {
      ...defaultCapture(status),
      ...(conversation.capture || {}),
      ...patch,
      status
    };
    refreshCaptureStats(conversation);
    return conversation;
  }

  function finalizeCapture(record, result = {}, now = Date.now()) {
    const conversation = migrateConversation(record, now);
    const complete = Boolean(
      result.topReached &&
      result.bottomReached &&
      conversation.segments.length === 1 &&
      !conversation.capture.orderConflict
    );
    conversation.capture = {
      ...conversation.capture,
      status: complete ? "complete" : (conversation.segments.length > 1 ? "gapped" : "partial"),
      completedAt: complete ? now : conversation.capture.completedAt,
      lastScanAt: now,
      topReached: Boolean(result.topReached),
      bottomReached: Boolean(result.bottomReached),
      reliability: result.reliability || conversation.capture.reliability
    };
    refreshCaptureStats(conversation);
    return conversation;
  }

  const api = {
    SCHEMA_VERSION,
    normalizeText,
    hashString,
    createConversation,
    migrateConversation,
    getMessages,
    getMessageCount,
    mergeObservation,
    setCaptureStatus,
    finalizeCapture
  };

  globalScope.ChatRecallArchive = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
