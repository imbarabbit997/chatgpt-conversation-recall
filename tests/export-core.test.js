const assert = require("node:assert/strict");
const archive = require("../archive-core.js");
const exporter = require("../export-core.js");

const conversation = archive.finalizeCapture(
  archive.mergeObservation(null, [
    { stableId: "u1", role: "user", text: "请帮我写一个函数。" },
    { stableId: "a1", role: "assistant", text: "当然。\n\n```js\nconsole.log('ok');\n```" }
  ], {
    id: "conv-1",
    title: "测试/非法:文件名?",
    url: "https://chatgpt.com/c/conv-1"
  }, { now: 1_700_000_000_000 }).conversation,
  { topReached: true, bottomReached: true, reliability: "strong" },
  1_700_000_100_000
);

const partial = archive.mergeObservation(null, [
  { stableId: "u2", role: "user", text: "尚未完整的对话" }
], {
  id: "conv-2",
  title: "部分保存",
  url: "https://chatgpt.com/c/conv-2"
}, { now: 1_700_000_200_000 }).conversation;

assert.equal(exporter.sanitizeFileName("A/B:C*D?"), "A B C D");
assert.equal(exporter.isComplete(conversation), true);
assert.equal(exporter.isComplete(partial), false);

const markdown = exporter.exportConversations([conversation], {
  format: "markdown",
  archive,
  generatedAt: 1_700_000_300_000
});
assert.equal(markdown.format, "markdown");
assert.equal(markdown.conversationCount, 1);
assert.equal(markdown.messageCount, 2);
assert.equal(markdown.incompleteCount, 0);
assert.match(markdown.filename, /^测试 非法 文件名_\d{4}-\d{2}-\d{2}\.md$/);
assert.match(markdown.content, /^# 测试\/非法:文件名\?/);
assert.match(markdown.content, /## 001 用户/);
assert.match(markdown.content, /```js\nconsole\.log\('ok'\);\n```/);

const text = exporter.exportConversations([conversation, partial], {
  format: "txt",
  archive,
  generatedAt: 1_700_000_300_000
});
assert.equal(text.format, "txt");
assert.equal(text.conversationCount, 2);
assert.equal(text.messageCount, 3);
assert.equal(text.incompleteCount, 1);
assert.match(text.filename, /^ChatGPT 对话导出_2段_\d{4}-\d{2}-\d{2}\.txt$/);
assert.match(text.content, /注意：这个对话尚未标记为完整保存/);
assert.match(text.content, /\[001\] 用户/);

assert.throws(() => exporter.exportConversations([], { archive }), /NO_CONVERSATIONS_SELECTED/);

console.log("export-core tests passed");
