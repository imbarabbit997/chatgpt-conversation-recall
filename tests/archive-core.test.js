const assert = require("node:assert/strict");
const archive = require("../archive-core.js");

const meta = {
  id: "conversation-1",
  title: "测试对话",
  url: "https://chatgpt.com/c/conversation-1"
};

let result = archive.mergeObservation(null, [
  { stableId: "m1", role: "user", text: "第一条" },
  { stableId: "m2", role: "assistant", text: "第二条" }
], meta, { now: 100 });

assert.equal(result.newCount, 2);
assert.equal(archive.getMessageCount(result.conversation), 2);
assert.equal(result.conversation.segments.length, 1);

result = archive.mergeObservation(result.conversation, [
  { stableId: "m2", role: "assistant", text: "第二条" },
  { stableId: "m3", role: "user", text: "第三条" }
], meta, { now: 200 });

assert.equal(result.newCount, 1);
assert.deepEqual(
  archive.getMessages(result.conversation).map((message) => message.stableId),
  ["m1", "m2", "m3"]
);

result = archive.mergeObservation(result.conversation, [
  { stableId: "m8", role: "assistant", text: "第八条" },
  { stableId: "m9", role: "user", text: "第九条" }
], meta, { now: 300 });

assert.equal(result.conversation.segments.length, 2);
assert.equal(result.conversation.capture.hasGaps, true);

result = archive.mergeObservation(result.conversation, [
  { stableId: "m3", role: "user", text: "第三条" },
  { stableId: "m4", role: "assistant", text: "第四条" },
  { stableId: "m8", role: "assistant", text: "第八条" }
], meta, { now: 400 });

assert.equal(result.conversation.segments.length, 1);
assert.deepEqual(
  archive.getMessages(result.conversation).map((message) => message.stableId),
  ["m1", "m2", "m3", "m4", "m8", "m9"]
);

const complete = archive.finalizeCapture(result.conversation, {
  topReached: true,
  bottomReached: true,
  reliability: "strong"
}, 500);
assert.equal(complete.capture.status, "complete");
assert.equal(complete.capture.messageCount, 6);

const staleResult = archive.mergeObservation(complete, [
  { stableId: "m9", role: "user", text: "第九条" },
  { stableId: "m10", role: "assistant", text: "新增内容" }
], meta, { now: 600 });
assert.equal(staleResult.conversation.capture.status, "stale");
assert.equal(archive.getMessageCount(staleResult.conversation), 7);

let streaming = archive.mergeObservation(null, [
  { role: "assistant", text: "这是一段仍在持续生成、长度足以安全匹配的测试回答。" }
], { ...meta, id: "streaming" }, { now: 610 });
streaming = archive.mergeObservation(streaming.conversation, [
  { role: "assistant", text: "这是一段仍在持续生成、长度足以安全匹配的测试回答。现在已经生成完毕。" }
], { ...meta, id: "streaming" }, { now: 620 });
assert.equal(archive.getMessageCount(streaming.conversation), 1);
assert.match(archive.getMessages(streaming.conversation)[0].text, /生成完毕/);

const longMessages = Array.from({ length: 40 }, (_, index) => ({
  stableId: `long-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text: `长对话消息 ${index + 1}`
}));
let longConversation = null;
for (let start = 0; start < longMessages.length; start += 6) {
  const window = longMessages.slice(start, start + 10);
  longConversation = archive.mergeObservation(
    longConversation?.conversation || null,
    window,
    { ...meta, id: "long-conversation" },
    { now: 700 + start }
  );
}
assert.equal(archive.getMessageCount(longConversation.conversation), 40);
assert.equal(longConversation.conversation.segments.length, 1);
assert.deepEqual(
  archive.getMessages(longConversation.conversation).map((message) => message.stableId),
  longMessages.map((message) => message.stableId)
);

const legacy = archive.migrateConversation({
  id: "legacy",
  title: "旧记录",
  url: "https://chatgpt.com/c/legacy",
  createdAt: 1,
  updatedAt: 2,
  messages: [
    { id: "position-0", role: "user", text: "旧消息" }
  ]
}, 900);
assert.equal(legacy.schemaVersion, 2);
assert.equal(legacy.capture.status, "partial");
assert.equal(archive.getMessageCount(legacy), 1);

console.log("archive-core tests passed");
