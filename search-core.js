(function exposeSearchCore(globalScope) {
  "use strict";

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenizeQuery(query) {
    return normalizeText(query).split(" ").filter(Boolean);
  }

  function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let cursor = 0;
    while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
      count += 1;
      cursor += Math.max(needle.length, 1);
    }
    return count;
  }

  function createSnippet(text, tokens, radius = 72) {
    const source = String(text ?? "").replace(/\s+/g, " ").trim();
    const normalized = normalizeText(source);
    if (!source) return "";

    let matchIndex = -1;
    for (const token of tokens) {
      const index = normalized.indexOf(token);
      if (index !== -1 && (matchIndex === -1 || index < matchIndex)) {
        matchIndex = index;
      }
    }

    if (matchIndex === -1) {
      return source.length > radius * 2 ? `${source.slice(0, radius * 2)}…` : source;
    }

    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(source.length, matchIndex + radius);
    return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
  }

  function searchConversations(conversations, query, limit = 80) {
    const tokens = tokenizeQuery(query);
    if (!tokens.length) return [];
    const phrase = normalizeText(query);
    const results = [];

    for (const conversation of conversations) {
      const normalizedTitle = normalizeText(conversation.title);

      for (let index = 0; index < conversation.messages.length; index += 1) {
        const message = conversation.messages[index];
        const normalizedBody = normalizeText(message.text);
        const combined = `${normalizedTitle} ${normalizedBody}`;

        if (!tokens.every((token) => combined.includes(token))) continue;

        let score = 0;
        if (normalizedTitle.includes(phrase)) score += 80;
        if (normalizedBody.includes(phrase)) score += 55;
        for (const token of tokens) {
          score += countOccurrences(normalizedTitle, token) * 16;
          score += Math.min(countOccurrences(normalizedBody, token), 8) * 5;
        }
        score += Math.min((conversation.updatedAt || 0) / 1e12, 4);

        results.push({
          conversationId: conversation.id,
          title: conversation.title,
          url: conversation.url,
          updatedAt: conversation.updatedAt,
          role: message.role,
          messageId: message.id,
          messageIndex: index,
          snippet: createSnippet(message.text, tokens),
          score
        });
      }
    }

    return results
      .sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt)
      .slice(0, limit);
  }

  const api = { normalizeText, tokenizeQuery, createSnippet, searchConversations };
  globalScope.ChatRecallCore = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
