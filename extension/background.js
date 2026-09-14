// GhostGram - Background Service Worker (Manifest V3)
// Configures native sidePanel behavior and relays authenticated session cookies

chrome.runtime.onInstalled.addListener(() => {
  console.log("GhostGram Extension installed/updated.");
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

// Multi-tier session resolver
async function resolveInstagramSession() {
  let dsUserId = null;
  let csrftoken = null;
  const cookieMap = {};

  // Tier 1: Query cookies from URLs and domains
  const cookieTargets = [
    { url: "https://www.instagram.com/" },
    { url: "https://instagram.com/" },
    { domain: "instagram.com" },
    { domain: ".instagram.com" },
    { domain: "www.instagram.com" },
  ];

  for (const target of cookieTargets) {
    try {
      const cookies = await chrome.cookies.getAll(target);
      if (cookies && Array.isArray(cookies)) {
        for (const c of cookies) {
          cookieMap[c.name] = c.value;
          if (c.name === "ds_user_id" && c.value) dsUserId = c.value;
          if (c.name === "csrftoken" && c.value) csrftoken = c.value;
        }
      }
    } catch (e) {
      // ignore target-specific error
    }
  }

  if (dsUserId) {
    return {
      authenticated: true,
      dsUserId,
      csrftoken: csrftoken || "",
      source: "cookies_api",
    };
  }

  // Tier 2: Inspect active/open Instagram tabs
  try {
    const tabs = await chrome.tabs.query({
      url: ["*://*.instagram.com/*", "*://instagram.com/*"],
    });

    if (tabs && tabs.length > 0) {
      for (const tab of tabs) {
        if (!tab.id) continue;

        // Try direct message to content script first
        try {
          const tabRes = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_SESSION" });
          if (tabRes && tabRes.dsUserId) {
            return {
              authenticated: true,
              dsUserId: tabRes.dsUserId,
              csrftoken: tabRes.csrftoken || "",
              source: "content_script_message",
              tabId: tab.id,
            };
          }
        } catch (e) {
          // Content script may not be loaded yet in this tab
        }

        // Dynamically execute script in tab to read document.cookie / window
        try {
          const scriptResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const match = document.cookie.match(/(?:^|; )ds_user_id=([^;]*)/);
              const csrfMatch = document.cookie.match(/(?:^|; )csrftoken=([^;]*)/);
              let uid = match ? decodeURIComponent(match[1]) : null;
              let csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : null;

              if (!uid && window._sharedData?.config?.viewerId) {
                uid = String(window._sharedData.config.viewerId);
              }
              if (!csrf && window._sharedData?.config?.csrf_token) {
                csrf = String(window._sharedData.config.csrf_token);
              }
              if (!uid) {
                try {
                  uid = localStorage.getItem("ds_user_id");
                } catch (e) {}
              }

              return {
                dsUserId: uid || null,
                csrftoken: csrf || null,
                cookieCount: document.cookie.length,
              };
            },
          });

          if (scriptResults && scriptResults[0]?.result?.dsUserId) {
            const res = scriptResults[0].result;
            return {
              authenticated: true,
              dsUserId: res.dsUserId,
              csrftoken: res.csrftoken || "",
              source: "tab_execute_script",
              tabId: tab.id,
            };
          }
        } catch (e) {
          console.warn("Could not execute script in Instagram tab:", tab.id, e);
        }
      }
    }
  } catch (e) {
    console.warn("Tab query failed:", e);
  }

  // Tier 3: Check chrome.storage.local
  try {
    const stored = await chrome.storage.local.get(["instagram_session"]);
    if (stored?.instagram_session?.dsUserId) {
      return {
        authenticated: true,
        dsUserId: stored.instagram_session.dsUserId,
        csrftoken: stored.instagram_session.csrftoken || "",
        source: "storage_local",
      };
    }
  } catch (e) {
    // ignore
  }

  // Tier 4: Fetch shared_data
  try {
    const fetchRes = await fetch("https://www.instagram.com/data/shared_data/", {
      credentials: "include",
    });
    if (fetchRes.ok) {
      const data = await fetchRes.json();
      const viewerId = data?.config?.viewerId || data?.viewer?.id;
      const csrf = data?.config?.csrf_token;
      if (viewerId) {
        return {
          authenticated: true,
          dsUserId: String(viewerId),
          csrftoken: csrf || "",
          source: "shared_data_fetch",
        };
      }
    }
  } catch (e) {
    // ignore
  }

  return {
    authenticated: false,
    dsUserId: null,
    csrftoken: null,
    source: "none",
  };
}

// Handle runtime messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_INSTAGRAM_SESSION") {
    resolveInstagramSession()
      .then((session) => {
        sendResponse({
          ok: true,
          ...session,
        });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          error: err.message,
          authenticated: false,
        });
      });
    return true; // async
  }

  if (message.type === "INSTAGRAM_SESSION_BROADCAST") {
    // Save to storage
    if (message.dsUserId) {
      chrome.storage.local.set({
        instagram_session: {
          dsUserId: message.dsUserId,
          csrftoken: message.csrftoken,
          updatedAt: Date.now(),
        },
      });
    }
    return false;
  }

  if (message.type === "OPEN_INSTAGRAM_TAB") {
    chrome.tabs.create({ url: "https://www.instagram.com/" }, (tab) => {
      sendResponse({ ok: true, tabId: tab?.id });
    });
    return true;
  }

  if (message.type === "PROXY_FETCH_TAB") {
    // Execute a fetch request via an active Instagram tab
    chrome.tabs.query({ url: ["*://*.instagram.com/*", "*://instagram.com/*"] }, async (tabs) => {
      if (!tabs || tabs.length === 0) {
        sendResponse({ ok: false, error: "No open Instagram tab found" });
        return;
      }
      const targetTab = tabs[0];
      try {
        const response = await chrome.tabs.sendMessage(targetTab.id, {
          type: "PROXY_FETCH",
          url: message.url,
          method: message.method,
          headers: message.headers,
          body: message.body,
        });
        sendResponse(response);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true;
  }
});
