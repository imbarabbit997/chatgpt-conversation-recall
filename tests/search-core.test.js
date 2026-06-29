const assert = require("node:assert/strict");
const {
  normalizeText,
  tokenizeQuery,
  createSnippet,
  searchConversations
} = require("../search-core.js");

assert.equal(normalizeText("  中文　搜索\n"), "中文 搜索");
assert.deepEqual(tokenizeQuery("本地  索引"), ["本地", "索引"]);
assert.match(createSnippet("前文 ".repeat(40) + "核心功能" + " 后文".repeat(40), ["核心"]), /核心功能/);

const conversations = [{
  id: "alpha",
  title: "浏览器扩展规划",
  url: "https://chatgpt.com/c/alpha",
  updatedAt: 100,
  capture: { status: "complete", completedAt: 90, hasGaps: false },
  segments: [{
    id: "segment-a",
    messages: [
      { id: "m1", stableId: "one", role: "user", text: "请设计浏览器中的本地搜索功能。" },
      { id: "m2", stableId: "two", role: "assistant", text: "可以从本地索引与搜索结果排序开始。" }
    ]
  }]
}, {
  id: "beta",
  title: "晚餐菜单",
  url: "https://chatgpt.com/c/beta",
  updatedAt: 200,
  messages: [
    { id: "m3", role: "user", text: "今晚吃什么？" }
  ]
}];

const titleResult = searchConversations(conversations, "浏览器");
assert.equal(titleResult.length, 2);
assert.equal(titleResult[0].conversationId, "alpha");
assert.equal(titleResult[0].captureStatus, "complete");
assert.equal(titleResult[0].messageCount, 2);

const multiTokenResult = searchConversations(conversations, "本地 索引");
assert.equal(multiTokenResult.length, 1);
assert.equal(multiTokenResult[0].messageId, "m2");

assert.deepEqual(searchConversations(conversations, "不存在"), []);

console.log("search-core tests passed");
