export default defineBackground(() => {
  // Open side panel on toolbar icon click
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // Register context menus on install
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: 'ask-localclaw',
      title: 'Ask LocalClaw about "%s"',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'summarize-page',
      title: 'Summarize this page',
      contexts: ['page'],
    });
  });

  // Handle context menu clicks
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.id) return;

    // Open side panel first
    await chrome.sidePanel.open({ tabId: tab.id });

    // Small delay to let panel mount
    setTimeout(() => {
      if (info.menuItemId === 'ask-localclaw' && info.selectionText) {
        chrome.runtime.sendMessage({
          type: 'CONTEXT_MENU_ACTION',
          action: 'ask',
          text: info.selectionText,
          pageUrl: info.pageUrl,
          pageTitle: tab.title ?? '',
        });
      } else if (info.menuItemId === 'summarize-page') {
        chrome.runtime.sendMessage({
          type: 'CONTEXT_MENU_ACTION',
          action: 'summarize',
          pageUrl: info.pageUrl,
          pageTitle: tab.title ?? '',
        });
      }
    }, 500);
  });

  // Relay page context requests from side panel → content script on active tab
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_PAGE_CONTEXT') {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab?.id) {
          sendResponse({ url: '', title: '', selectedText: '', pageContent: '' });
          return;
        }

        // Send message to the content script running on the active tab
        chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAGE_CONTEXT' }, (response) => {
          if (chrome.runtime.lastError || !response) {
            // Content script not available — return what we can from the tab
            sendResponse({
              url: tab.url ?? '',
              title: tab.title ?? '',
              selectedText: '',
              pageContent: '',
            });
          } else {
            sendResponse(response);
          }
        });
      });
      return true; // Keep channel open for async response
    }

    // Navigate active tab (called by content script — can't navigate itself without dying)
    if (message.type === 'NAVIGATE_TAB') {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.update(tabs[0].id, { url: message.url });
        }
      });
      return;
    }

    // Relay browser actions from side panel → content script on active tab
    // Injects content script on-demand if not already present
    if (message.type === 'RELAY_BROWSER_ACTION') {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab?.id) {
          sendResponse({ success: false, result: 'No active tab' });
          return;
        }

        const sendAction = () => {
          chrome.tabs.sendMessage(tab.id!, {
            type: 'BROWSER_ACTION',
            action: message.action,
            ref: message.ref,
            text: message.text,
            url: message.url,
            direction: message.direction,
            selector: message.selector,
          }, (response) => {
            if (chrome.runtime.lastError || !response) {
              sendResponse({ success: false, result: chrome.runtime.lastError?.message ?? 'Content script unavailable' });
            } else {
              sendResponse(response);
            }
          });
        };

        // Try sending directly first — if content script is already loaded
        chrome.tabs.sendMessage(tab.id, { type: 'PING' }, (reply) => {
          if (chrome.runtime.lastError || !reply) {
            // Content script not loaded — inject it, wait, then send action
            chrome.scripting.executeScript({
              target: { tabId: tab.id! },
              files: ['content-scripts/content.js'],
            }).then(() => {
              // Give it a moment to set up message listeners
              setTimeout(sendAction, 500);
            }).catch(() => {
              sendResponse({ success: false, result: 'Cannot inject content script on this page' });
            });
          } else {
            sendAction();
          }
        });
      });
      return true;
    }
  });
});
