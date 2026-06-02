export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Respond to page context requests from the side panel / background
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'EXTRACT_PAGE_CONTEXT') {
        const selectedText = window.getSelection()?.toString() ?? '';

        // Smart content extraction — prefer article/main over full body
        let pageContent = '';
        const selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent && el.textContent.trim().length > 200) {
            pageContent = el.textContent.trim();
            break;
          }
        }
        if (!pageContent) {
          pageContent = document.body?.innerText ?? '';
        }

        // Truncate to ~10K chars
        if (pageContent.length > 10_000) {
          pageContent = pageContent.slice(0, 10_000) + '\n[...truncated]';
        }

        sendResponse({
          url: window.location.href,
          title: document.title,
          selectedText,
          pageContent,
        });
      }
    });
  },
});
