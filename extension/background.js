// GhostGram - Background Service Worker (Manifest V3)
// Configures native sidePanel behavior and relays authenticated session cookies

chrome.runtime.onInstalled.addListener(() => {
  console.log("GhostGram Extension installed successfully.");
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn("Could not set panel behavior:", err);
    });
  }
});

// Fallback click handler if openPanelOnActionClick is unsupported or fails
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab && tab.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.error("Failed to open sidePanel:", err);
  }
});

// Handle cookie & session queries from the side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_INSTAGRAM_SESSION") {
    chrome.cookies.getAll({ domain: ".instagram.com" }, (cookies) => {
      if (chrome.runtime.lastError || !cookies) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message || "No cookies found" });
        return;
      }
      const cookieMap = {};
      for (const c of cookies) {
        cookieMap[c.name] = c.value;
      }
      const dsUserId = cookieMap["ds_user_id"] || null;
      const csrftoken = cookieMap["csrftoken"] || null;
      sendResponse({
        ok: true,
        authenticated: Boolean(dsUserId),
        dsUserId,
        csrftoken,
        cookies: cookieMap,
      });
    });
    return true; // Keep channel open for async response
  }

  if (message.type === "OPEN_INSTAGRAM_TAB") {
    chrome.tabs.create({ url: "https://www.instagram.com/" }, (tab) => {
      sendResponse({ ok: true, tabId: tab?.id });
    });
    return true;
  }
});
