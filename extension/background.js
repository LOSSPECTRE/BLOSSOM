// Create right-click context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "bloscom-ai",
    title: "Ask BLOSCOM-AI",
    contexts: ["all"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "bloscom-ai") return;

  // Inject CSS + content script first, then open overlay
  chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["overlay.css"] })
    .catch(() => {});
  chrome.scripting.executeScript(
    { target: { tabId: tab.id }, files: ["content.js"] },
    () => {
      chrome.runtime.lastError; // suppress "already injected" error
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, {
          type: "OPEN_BLOSCOM",
          selectedText: info.selectionText || ""
        }).catch(() => {});
      }, 150);
    }
  );
});

// Keep service worker alive while content script holds a port open
chrome.runtime.onConnect.addListener(port => {
  if (port.name === "keepalive") port.onDisconnect.addListener(() => {});
});

// Handle all messages from content script
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // Take screenshot of current tab
  if (msg.type === "CAPTURE_TAB") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      sendResponse({ dataUrl });
    });
    return true;
  }

  // Plan actions using vision + AI
  if (msg.type === "PLAN_ACTIONS") {
    planActions(msg)
      .then(result => sendResponse(result))
      .catch(err  => sendResponse({ error: err.message, steps: [] }));
    return true;
  }

  // Regular chat message
  if (msg.type === "ASK_AI") {
    askAI(msg.message, msg.history)
      .then(reply => sendResponse({ reply }))
      .catch(err  => sendResponse({ error: err.message }));
    return true;
  }
});

async function planActions({ instruction, screenshot, elements, url, title }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000); // 90s timeout
  try {
    const res = await fetch("http://localhost:3000/api/agent/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction, screenshot, elements, url, title }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error("Server error");
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function askAI(message, history = []) {
  const res = await fetch("http://localhost:3000/api/jarvis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history })
  });
  if (!res.ok) throw new Error("Server error");

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let reply = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") break;
      try { reply += JSON.parse(data).content || ""; } catch {}
    }
  }
  return reply.trim();
}
