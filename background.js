chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.startsWith("https://chatgpt.com/")) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "CHAT_RECALL_TOGGLE" });
  } catch {
    // The content script may not be ready during a navigation. A second click
    // after the page settles will open the panel.
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "CHAT_RECALL_DOWNLOAD") return false;

  const run = async () => {
    const bytes = new TextEncoder().encode(String(message.content || ""));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const url = `data:${message.mime || "text/plain;charset=utf-8"};base64,${btoa(binary)}`;
    const downloadId = await chrome.downloads.download({
      url,
      filename: message.filename || "chatgpt-conversation-export.txt",
      saveAs: true,
      conflictAction: "uniquify"
    });
    return { ok: true, downloadId };
  };

  run()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      error: error?.message || String(error)
    }));

  return true;
});
