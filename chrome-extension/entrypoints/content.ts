export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Respond to page context requests from the side panel / background
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'EXTRACT_PAGE_CONTEXT') {
        const selectedText = window.getSelection()?.toString() ?? '';

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

      // Browser action execution — structured commands from LocalClaw
      if (message.type === 'BROWSER_ACTION') {
        const action = message.action as string;
        const ref = message.ref as string | undefined;
        const text = message.text as string | undefined;
        const url = message.url as string | undefined;
        const direction = message.direction as string | undefined;
        const selector = message.selector as string | undefined;

        try {
          const result = executeBrowserAction(action, { ref, text, url, direction, selector });
          sendResponse({ success: true, result });
        } catch (err) {
          sendResponse({ success: false, result: err instanceof Error ? err.message : String(err) });
        }
        return true; // async response
      }
    });
  },
});

// ── Snapshot: index interactive elements ──

let refIndex = 0;
const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea']);

function snapshot(): string {
  refIndex = 0;
  const body = document.body;
  if (!body) return '(empty page)';

  const lines: string[] = [];
  walkDOM(body, lines);

  return `Page: ${document.title}\nURL: ${window.location.href}\n\n${lines.join('\n').slice(0, 10_000)}`;
}

function walkDOM(node: Node, lines: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent?.trim();
    if (text) lines.push(text);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (['script', 'style', 'noscript', 'svg'].includes(tag)) return;

  // Check visibility
  if (el.offsetParent === null && tag !== 'body' && tag !== 'html') {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (style.position !== 'fixed' && style.position !== 'sticky') return;
  }

  if (INTERACTIVE.has(tag)) {
    refIndex++;
    el.setAttribute('data-ref', String(refIndex));

    let label = el.getAttribute('aria-label')
      || el.getAttribute('title')
      || el.getAttribute('name')
      || el.textContent?.trim().slice(0, 60)
      || '';

    // Input-specific labeling
    if (tag === 'input' || tag === 'textarea') {
      const input = el as HTMLInputElement;
      const type = input.type || 'text';
      const placeholder = input.placeholder ? ` (placeholder: "${input.placeholder}")` : '';
      const value = input.value ? ` = "${input.value.slice(0, 40)}"` : '';
      // Try to find associated label
      if (input.id) {
        const labelEl = document.querySelector(`label[for="${input.id}"]`);
        if (labelEl) label = labelEl.textContent?.trim() || label;
      }
      lines.push(`[${refIndex}: ${tag} ${type}] ${label}${placeholder}${value}`);
    } else if (tag === 'select') {
      const select = el as HTMLSelectElement;
      const options = Array.from(select.options).map(o => o.text.trim()).slice(0, 5).join(', ');
      lines.push(`[${refIndex}: select] ${label} {${options}}`);
    } else if (tag === 'a') {
      const href = (el as HTMLAnchorElement).href;
      lines.push(`[${refIndex}: link] ${label || href}`);
    } else {
      lines.push(`[${refIndex}: ${tag}] ${label}`);
    }
    return; // Don't recurse into interactive elements
  }

  for (const child of el.childNodes) {
    walkDOM(child, lines);
  }
}

// ── Action executor ──

function executeBrowserAction(
  action: string,
  params: { ref?: string; text?: string; url?: string; direction?: string; selector?: string },
): string {
  switch (action) {
    case 'snapshot':
      return snapshot();

    case 'pressKey': {
      const key = params.text ?? 'Enter';
      const target = params.ref ? resolveElement(params.ref) : document.activeElement;
      const el = (target ?? document.body) as HTMLElement;
      const keyMap: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8 };
      const keyCode = keyMap[key] ?? 0;
      el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key, code: key, keyCode, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, keyCode, bubbles: true }));
      // For Enter on forms, also try submitting the form
      if (key === 'Enter') {
        const form = el.closest('form');
        if (form) form.requestSubmit();
      }
      return `Pressed ${key}`;
    }

    case 'text_content':
      return `Page: ${document.title}\nURL: ${window.location.href}\n\n${document.body?.innerText?.slice(0, 10_000) ?? ''}`;

    case 'click': {
      const el = resolveElement(params.ref);
      if (!el) return `Element "${params.ref}" not found`;
      el.click();
      return `Clicked "${params.ref}". Page: ${window.location.href}`;
    }

    case 'type': {
      const el = resolveElement(params.ref) as HTMLInputElement | null;
      if (!el) return `Element "${params.ref}" not found`;
      if (!params.text) return 'Error: text parameter required';
      el.focus();
      // React-compatible value setting — use the right prototype for the element type
      try {
        const isTextarea = el.tagName?.toLowerCase() === 'textarea';
        const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, params.text);
        } else {
          el.value = params.text;
        }
      } catch {
        // Fallback for non-standard inputs (contenteditable, custom elements)
        el.value = params.text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `Typed "${params.text}" into "${params.ref}"`;
    }

    case 'select': {
      const el = resolveElement(params.ref) as HTMLSelectElement | null;
      if (!el) return `Element "${params.ref}" not found`;
      if (!params.text) return 'Error: text parameter required';
      // Find option by text or value
      const option = Array.from(el.options).find(
        o => o.text.trim().toLowerCase() === params.text!.toLowerCase()
          || o.value.toLowerCase() === params.text!.toLowerCase()
      );
      if (!option) return `Option "${params.text}" not found in select`;
      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `Selected "${params.text}" in "${params.ref}"`;
    }

    case 'scroll': {
      const amount = window.innerHeight * 0.8;
      if (params.direction === 'up') {
        window.scrollBy(0, -amount);
      } else {
        window.scrollBy(0, amount);
      }
      return `Scrolled ${params.direction || 'down'}`;
    }

    case 'wait': {
      const sel = params.selector || params.ref;
      if (!sel) return 'Error: selector parameter required';
      const found = document.querySelector(sel);
      if (found) return `Element "${sel}" is present`;
      return `Element "${sel}" not found yet`;
    }

    case 'navigate': {
      if (!params.url) return 'Error: url parameter required';
      // Navigation handled by background service worker (content script dies on page unload)
      chrome.runtime.sendMessage({ type: 'NAVIGATE_TAB', url: params.url });
      return `Navigating to ${params.url}`;
    }

    default:
      return `Unknown action: ${action}`;
  }
}

function resolveElement(ref?: string): HTMLElement | null {
  if (!ref) return null;

  // By snapshot ref number
  if (/^\d+$/.test(ref.trim())) {
    return document.querySelector(`[data-ref="${ref.trim()}"]`);
  }

  // By CSS selector
  if (ref.startsWith('.') || ref.startsWith('#') || ref.startsWith('[') || ref.includes(' > ')) {
    return document.querySelector(ref);
  }

  // By text content — find interactive element containing this text
  const allInteractive = document.querySelectorAll('a, button, input, select, textarea');
  for (const el of allInteractive) {
    const text = el.textContent?.trim().toLowerCase() ?? '';
    const aria = el.getAttribute('aria-label')?.toLowerCase() ?? '';
    const placeholder = (el as HTMLInputElement).placeholder?.toLowerCase() ?? '';
    if (text.includes(ref.toLowerCase()) || aria.includes(ref.toLowerCase()) || placeholder.includes(ref.toLowerCase())) {
      return el as HTMLElement;
    }
  }

  return null;
}
