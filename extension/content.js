// GhostGram Content Script
// Runs inside active Instagram web tabs (https://www.instagram.com/*)
// Seamlessly extracts session tokens and provides 1st-party API execution bridge

(function () {
  function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) {
      return decodeURIComponent(parts.pop().split(";").shift());
    }
    return null;
  }

  function getSessionInfo() {
    let dsUserId = getCookie("ds_user_id");
    let csrftoken = getCookie("csrftoken");

    // Fallback: check window._sharedData if present
    if (!dsUserId && window._sharedData?.config?.viewerId) {
      dsUserId = String(window._sharedData.config.viewerId);
    }
    if (!csrftoken && window._sharedData?.config?.csrf_token) {
      csrftoken = String(window._sharedData.config.csrf_token);
    }

    // Fallback: check localStorage
    if (!dsUserId) {
      try {
        dsUserId = localStorage.getItem("ds_user_id");
      } catch (e) {}
    }

    return {
      dsUserId: dsUserId || null,
      csrftoken: csrftoken || null,
      authenticated: Boolean(dsUserId),
      url: window.location.href,
    };
  }

  // Save detected session to extension storage
  function syncSession() {
    const session = getSessionInfo();
    if (session.authenticated && chrome.storage?.local) {
      chrome.storage.local.set({
        instagram_session: {
          ...session,
          updatedAt: Date.now(),
        },
      });
      // Notify background / sidepanel
      try {
        chrome.runtime.sendMessage({
          type: "INSTAGRAM_SESSION_BROADCAST",
          ...session,
        });
      } catch (e) {
        // Extension context might be reloaded
      }
    }
  }

  // Initial sync
  syncSession();

  // Periodic check (every 5 seconds) to catch login state changes
  setInterval(syncSession, 5000);

  // Listen for direct queries or proxy fetch requests from side panel
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "GET_PAGE_SESSION") {
      const session = getSessionInfo();
      sendResponse(session);
      return true;
    }

    if (request.type === "PROXY_FETCH") {
      // Execute fetch inside first-party Instagram page context
      const fetchUrl = request.url;
      const options = {
        method: request.method || "GET",
        headers: {
          "X-IG-App-ID": "936619743392459",
          "X-CSRFToken": getCookie("csrftoken") || "",
          "X-Requested-With": "XMLHttpRequest",
          ...(request.headers || {}),
        },
        credentials: "include",
      };

      if (request.body) {
        options.body = request.body;
      }

      fetch(fetchUrl, options)
        .then(async (res) => {
          const contentType = res.headers.get("content-type") || "";
          let data;
          if (contentType.includes("application/json")) {
            data = await res.json();
          } else {
            data = await res.text();
          }
          sendResponse({
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            data,
          });
        })
        .catch((err) => {
          sendResponse({
            ok: false,
            status: 0,
            error: err.message || "Network request failed in page context",
          });
        });

      return true; // Keep channel open for async response
    }
  });
})();
