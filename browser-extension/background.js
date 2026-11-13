/**
 * HeyClicky Clone - Chrome MV3 Background Service Worker
 * 
 * Bridges the Rust desktop core via Chrome Native Messaging (`com.heyclicky.clone`)
 * with browser tabs and content scripts for zero-latency automation.
 */

const NATIVE_HOST_NAME = "com.heyclicky.clone";
let nativePort = null;
let reconnectTimer = null;
let isConnecting = false;

// Connect to Native Messaging Host
function connectNativeHost() {
  if (isConnecting || nativePort) return;
  isConnecting = true;

  try {
    console.log(`[HeyClicky] Connecting to native host '${NATIVE_HOST_NAME}'...`);
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((msg) => {
      console.log("[HeyClicky] Message from native host:", msg);
      handleNativeMessage(msg);
    });

    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      console.warn("[HeyClicky] Native host disconnected:", error ? error.message : "Normal disconnect");
      nativePort = null;
      isConnecting = false;

      // Schedule reconnection attempt with backoff
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectNativeHost();
        }, 5000);
      }
    });

    console.log("[HeyClicky] Native port established successfully.");
    isConnecting = false;
  } catch (err) {
    console.error("[HeyClicky] Error connecting to native host:", err);
    nativePort = null;
    isConnecting = false;
  }
}

// Send response back to Native Messaging Host
function sendNativeResponse(response) {
  if (nativePort) {
    try {
      nativePort.postMessage(response);
    } catch (err) {
      console.error("[HeyClicky] Failed to post message to native host:", err);
    }
  } else {
    console.warn("[HeyClicky] Cannot reply: Native port is closed.", response);
  }
}

// Ensure content script is injected in the specified tab
async function ensureContentScript(tabId) {
  try {
    // Attempt pinging content script
    const pong = await chrome.tabs.sendMessage(tabId, { action: "ping" });
    if (pong && pong.status === "pong") {
      return true;
    }
  } catch (_e) {
    // Not injected yet, inject programmatically
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content.js"]
    });
    return true;
  } catch (err) {
    console.error(`[HeyClicky] Failed to inject content script into tab ${tabId}:`, err);
    return false;
  }
}

// Resolve target tab (specific tab_id or currently active tab)
async function resolveTab(tabId) {
  if (typeof tabId === "number" && tabId > 0) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (_e) {
      // Fallback to active tab
    }
  }
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab || null;
}

// Route message received from native host
async function handleNativeMessage(msg) {
  if (!msg || typeof msg !== "object") {
    sendNativeResponse({ id: msg?.id, success: false, error: "Invalid message payload" });
    return;
  }

  const { id, type, action, ...params } = msg;
  const command = type || action;

  try {
    switch (command) {
      case "ping": {
        sendNativeResponse({
          id,
          success: true,
          type: "pong",
          timestamp: Date.now()
        });
        break;
      }

      case "list_tabs": {
        const tabs = await chrome.tabs.query({});
        const tabList = tabs.map(t => ({
          id: t.id,
          title: t.title || "",
          url: t.url || "",
          active: t.active,
          windowId: t.windowId
        }));
        sendNativeResponse({
          id,
          success: true,
          tabs: tabList
        });
        break;
      }

      case "browser_navigate":
      case "navigate_tab": {
        if (!params.url) {
          sendNativeResponse({ id, success: false, error: "Missing required 'url' parameter" });
          return;
        }
        const targetTab = await resolveTab(params.tab_id);
        if (!targetTab || !targetTab.id) {
          // Open in a new tab if no active tab found
          const created = await chrome.tabs.create({ url: params.url, active: true });
          sendNativeResponse({ id, success: true, tab_id: created.id, url: params.url });
        } else {
          const updated = await chrome.tabs.update(targetTab.id, { url: params.url });
          sendNativeResponse({ id, success: true, tab_id: updated.id, url: params.url });
        }
        break;
      }

      case "browser_get_dom":
      case "get_dom": {
        const targetTab = await resolveTab(params.tab_id);
        if (!targetTab || !targetTab.id) {
          sendNativeResponse({ id, success: false, error: "No active browser tab found" });
          return;
        }

        // Check if page is an internal chrome URL
        if (targetTab.url && (targetTab.url.startsWith("chrome://") || targetTab.url.startsWith("edge://") || targetTab.url.startsWith("about:"))) {
          sendNativeResponse({
            id,
            success: false,
            error: `Cannot inspect internal browser page: ${targetTab.url}`
          });
          return;
        }

        const ready = await ensureContentScript(targetTab.id);
        if (!ready) {
          sendNativeResponse({ id, success: false, error: "Unable to attach to tab content" });
          return;
        }

        const domResult = await chrome.tabs.sendMessage(targetTab.id, { action: "browser_get_dom" });
        sendNativeResponse({
          id,
          success: true,
          tab_id: targetTab.id,
          title: domResult?.title || targetTab.title,
          url: domResult?.url || targetTab.url,
          elements: domResult?.elements || []
        });
        break;
      }

      case "browser_click":
      case "click": {
        if (!params.selector) {
          sendNativeResponse({ id, success: false, error: "Missing 'selector' parameter" });
          return;
        }
        const targetTab = await resolveTab(params.tab_id);
        if (!targetTab || !targetTab.id) {
          sendNativeResponse({ id, success: false, error: "No active tab" });
          return;
        }
        await ensureContentScript(targetTab.id);
        const clickResult = await chrome.tabs.sendMessage(targetTab.id, {
          action: "browser_click",
          selector: params.selector
        });
        sendNativeResponse({ id, ...clickResult, tab_id: targetTab.id });
        break;
      }

      case "browser_type":
      case "type": {
        if (!params.selector) {
          sendNativeResponse({ id, success: false, error: "Missing 'selector' parameter" });
          return;
        }
        const targetTab = await resolveTab(params.tab_id);
        if (!targetTab || !targetTab.id) {
          sendNativeResponse({ id, success: false, error: "No active tab" });
          return;
        }
        await ensureContentScript(targetTab.id);
        const typeResult = await chrome.tabs.sendMessage(targetTab.id, {
          action: "browser_type",
          selector: params.selector,
          text: params.text || ""
        });
        sendNativeResponse({ id, ...typeResult, tab_id: targetTab.id });
        break;
      }

      default: {
        sendNativeResponse({ id, success: false, error: `Unrecognized command: ${command}` });
        break;
      }
    }
  } catch (err) {
    console.error("[HeyClicky] Error processing command:", command, err);
    sendNativeResponse({ id, success: false, error: String(err.message || err) });
  }
}

// Lifecycle listeners
chrome.runtime.onStartup.addListener(() => {
  connectNativeHost();
});

chrome.runtime.onInstalled.addListener(() => {
  connectNativeHost();
});

// Auto-connect on worker initial load
connectNativeHost();
