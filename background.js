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
