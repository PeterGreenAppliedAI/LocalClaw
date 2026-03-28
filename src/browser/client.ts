/**
 * Browser automation client using Playwright.
 * Provides tab management, navigation, snapshots, screenshots,
 * and interactive actions (click, type, select).
 */
export class BrowserClient {
  private browser: any = null;
  private pages = new Map<string, any>();
  private activeTabId = 'default';

  async launch(options?: { headless?: boolean; executablePath?: string; display?: string }): Promise<void> {
    let pw: any;
    try {
      const mod = 'playwright-core';
      pw = await import(/* webpackIgnore: true */ mod);
    } catch {
      throw new Error('playwright-core not installed. Run: npm i playwright-core');
    }

    // Visual mode: launch non-headless against an Xvfb virtual display
    const env = options?.display
      ? { ...process.env, DISPLAY: options.display }
      : undefined;

    const headless = options?.display ? false : (options?.headless ?? true);

    this.browser = await pw.chromium.launch({
      headless,
      executablePath: options?.executablePath,
      env,
    });

    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    this.pages.set('default', page);

    if (options?.display) {
      console.log(`[Browser] Launched in visual mode on display ${options.display}`);
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.pages.clear();
    }
  }

  isRunning(): boolean {
    return this.browser !== null;
  }

  async navigate(url: string, tabId?: string): Promise<string> {
    const page = this.getPage(tabId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for JS-heavy pages to finish rendering (network idle or 3s max)
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
    return page.url();
  }

  async snapshot(tabId?: string): Promise<string> {
    const page = this.getPage(tabId);
    const title = await page.title();
    const url = page.url();

    // AI-friendly snapshot with indexed interactive elements
    const text: string = await page.evaluate(SNAPSHOT_SCRIPT);

    return `Page: ${title}\nURL: ${url}\n\n${text.slice(0, 10000)}`;
  }

  /**
   * Get the rendered visible text from the page — what the user actually sees.
   * Unlike snapshot() which walks the DOM tree (and may hit unrendered SPA templates),
   * this uses innerText which returns only visible, rendered content after JavaScript runs.
   * Waits briefly for dynamic content to load on SPAs.
   */
  async textContent(tabId?: string): Promise<string> {
    const page = this.getPage(tabId);

    // Wait for SPA content to render — network idle or 3s max
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
    // Extra wait for React/Vue hydration
    await page.waitForTimeout(1_500);

    const title = await page.title();
    const url = page.url();

    const text: string = await page.evaluate('(() => { return document.body ? document.body.innerText : ""; })()') ?? '';

    return `Page: ${title}\nURL: ${url}\n\n${text.slice(0, 10000)}`;
  }

  async screenshot(tabId?: string): Promise<Buffer> {
    const page = this.getPage(tabId);
    return page.screenshot({ type: 'png', fullPage: false });
  }

  /**
   * Re-index interactive elements on the page before resolving a reference.
   * This ensures element numbers are fresh even if the page changed since
   * the last snapshot (navigation, dynamic content, etc.).
   */
  private async freshResolveRef(page: any, refNum: number): Promise<string | null> {
    // Re-run the snapshot script to assign fresh data-ref attributes
    await page.evaluate(SNAPSHOT_SCRIPT);
    return page.evaluate(RESOLVE_REF_SCRIPT, refNum);
  }

  /** Visual fallback config — set by the browser tool when visual mode is available */
  visualConfig: import('./visual.js').VisualBrowserConfig | null = null;

  /**
   * Click an interactive element. DOM-first with automatic visual escalation.
   *
   * Tries in order:
   * 1. DOM click by snapshot index (data-ref attribute)
   * 2. DOM click by CSS selector
   * 3. Visual click by description (if visual mode available and ref is text)
   *
   * Escalation is logged so the decision is auditable.
   */
  async click(ref: string, tabId?: string): Promise<string> {
    const page = this.getPage(tabId);
    const isIndex = /^\d+$/.test(ref.trim());

    // Attempt 1: DOM click by index
    if (isIndex) {
      const selector = await this.freshResolveRef(page, parseInt(ref, 10));
      if (selector) {
        try {
          await page.click(selector, { timeout: 5_000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
          console.log(`[Browser] DOM click #${ref} succeeded`);
          return `Clicked element #${ref}. Page: ${page.url()}`;
        } catch (err) {
          console.log(`[Browser] DOM click #${ref} failed: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        console.log(`[Browser] DOM click #${ref}: element not found in DOM`);
      }
    }

    // Attempt 2: DOM click by CSS selector (if ref looks like one)
    if (!isIndex && (ref.startsWith('.') || ref.startsWith('#') || ref.startsWith('[') || ref.includes(' > '))) {
      try {
        await page.click(ref, { timeout: 5_000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
        console.log(`[Browser] DOM click "${ref}" succeeded`);
        return `Clicked "${ref}". Page: ${page.url()}`;
      } catch (err) {
        console.log(`[Browser] DOM click "${ref}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Attempt 3: Visual escalation — use vision model to find and click by description
    if (this.visualConfig) {
      console.log(`[Browser] Escalating to visual mode for: "${ref}"`);
      const { visualClick } = await import('./visual.js');
      return await visualClick(this, this.visualConfig, ref, tabId);
    }

    return `Element "${ref}" not found via DOM. Visual mode not available for fallback.`;
  }

  /**
   * Type text into an element. DOM-first with automatic visual escalation.
   */
  async type(ref: string, text: string, tabId?: string): Promise<string> {
    const page = this.getPage(tabId);
    const isIndex = /^\d+$/.test(ref.trim());

    // Attempt 1: DOM fill by index
    if (isIndex) {
      const selector = await this.freshResolveRef(page, parseInt(ref, 10));
      if (selector) {
        try {
          await page.fill(selector, text, { timeout: 5_000 });
          console.log(`[Browser] DOM type #${ref} succeeded`);
          return `Typed "${text}" into element #${ref}`;
        } catch (err) {
          console.log(`[Browser] DOM type #${ref} failed: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        console.log(`[Browser] DOM type #${ref}: element not found in DOM`);
      }
    }

    // Attempt 2: DOM fill by CSS selector
    if (!isIndex && (ref.startsWith('.') || ref.startsWith('#') || ref.startsWith('[') || ref.includes(' > '))) {
      try {
        await page.fill(ref, text, { timeout: 5_000 });
        console.log(`[Browser] DOM type "${ref}" succeeded`);
        return `Typed "${text}" into "${ref}"`;
      } catch (err) {
        console.log(`[Browser] DOM type "${ref}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Attempt 3: Visual escalation
    if (this.visualConfig) {
      console.log(`[Browser] Escalating to visual mode for type: "${ref}"`);
      const { visualType } = await import('./visual.js');
      return await visualType(this, this.visualConfig, ref, text, tabId);
    }

    return `Element "${ref}" not found via DOM. Visual mode not available for fallback.`;
  }

  /**
   * Select an option from a <select> dropdown. DOM-first, no visual fallback
   * (select dropdowns are standard DOM elements).
   */
  async select(ref: string, value: string, tabId?: string): Promise<string> {
    const page = this.getPage(tabId);

    const isIndex = /^\d+$/.test(ref.trim());
    if (isIndex) {
      const selector = await this.freshResolveRef(page, parseInt(ref, 10));
      if (!selector) return `Element #${ref} not found on page`;
      await page.selectOption(selector, value, { timeout: 10_000 });
      return `Selected "${value}" in element #${ref}`;
    }

    await page.selectOption(ref, value, { timeout: 10_000 });
    return `Selected "${value}" in "${ref}"`;
  }

  /**
   * Wait for a CSS selector to appear on page.
   */
  async waitFor(selector: string, timeoutMs = 10_000, tabId?: string): Promise<string> {
    const page = this.getPage(tabId);
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return `Element "${selector}" appeared`;
  }

  async openTab(id: string, url?: string): Promise<string> {
    if (!this.browser) throw new Error('Browser not running');

    const contexts = this.browser.contexts();
    const context = contexts[0] || await this.browser.newContext();
    const page = await context.newPage();
    this.pages.set(id, page);
    this.activeTabId = id;

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }

    return id;
  }

  async closeTab(id: string): Promise<void> {
    const page = this.pages.get(id);
    if (page) {
      await page.close();
      this.pages.delete(id);
      if (this.activeTabId === id) {
        this.activeTabId = this.pages.keys().next().value ?? 'default';
      }
    }
  }

  listTabs(): string[] {
    return [...this.pages.keys()];
  }

  async getConsole(tabId?: string): Promise<string[]> {
    return ['(console logging not yet captured)'];
  }

  async pdf(tabId?: string): Promise<Buffer> {
    const page = this.getPage(tabId);
    return page.pdf({ format: 'A4' });
  }

  /** Get the page for a tab. Public so visual mode can access it for coordinate clicks. */
  getPage(tabId?: string): any {
    const id = tabId ?? this.activeTabId;
    const page = this.pages.get(id);
    if (!page) throw new Error(`Tab "${id}" not found`);
    return page;
  }
}

/**
 * Injected into page context — walks the DOM and produces an AI-readable
 * snapshot with indexed interactive elements.
 *
 * Interactive elements (links, buttons, inputs, selects, textareas) get a
 * numbered reference like [3: button] Submit so the LLM can say "click 3".
 * The indices are stable within a single snapshot — they change on navigation.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const body = document.body;
  if (!body) return '(empty page)';
  let refIndex = 0;
  const INTERACTIVE = new Set(['a','button','input','select','textarea']);

  function walk(node, depth) {
    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (['script','style','noscript','svg'].includes(tag)) return '';

    // Interactive element — assign a reference number
    if (INTERACTIVE.has(tag) && isVisible(node)) {
      refIndex++;
      node.setAttribute('data-ref', String(refIndex));
      return formatInteractive(node, tag, refIndex);
    }

    const lines = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = (child.textContent || '').trim();
        if (t) lines.push(t);
      } else if (child.nodeType === 1) {
        const line = walk(child, depth + 1);
        if (line) lines.push(line);
      }
    }
    const content = lines.filter(Boolean).join('\\n');
    if (!content) return '';
    if (['h1','h2','h3','h4','h5','h6'].includes(tag)) return '[' + tag + '] ' + content;
    if (tag === 'li') return '• ' + content;
    if (tag === 'form') return '[form]\\n' + content + '\\n[/form]';
    return content;
  }

  function isVisible(el) {
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function formatInteractive(node, tag, idx) {
    const label = getLabel(node, tag);
    switch (tag) {
      case 'a':
        return '[' + idx + ': link] ' + label;
      case 'button':
        return '[' + idx + ': button] ' + label;
      case 'input': {
        const type = node.type || 'text';
        const val = node.value ? ' = "' + node.value + '"' : '';
        const ph = node.placeholder ? ' (' + node.placeholder + ')' : '';
        return '[' + idx + ': input ' + type + '] ' + label + ph + val;
      }
      case 'select': {
        const opts = Array.from(node.options || []).map(o => o.text).slice(0, 5);
        return '[' + idx + ': select] ' + label + ' {' + opts.join(', ') + '}';
      }
      case 'textarea': {
        const val = node.value ? ' = "' + node.value.slice(0, 50) + '"' : '';
        const ph = node.placeholder ? ' (' + node.placeholder + ')' : '';
        return '[' + idx + ': textarea] ' + label + ph + val;
      }
      default:
        return '[' + idx + ': ' + tag + '] ' + label;
    }
  }

  function getLabel(node, tag) {
    // Try aria-label, title, then inner text
    const aria = node.getAttribute('aria-label');
    if (aria) return aria;
    const title = node.getAttribute('title');
    if (title) return title;
    const name = node.getAttribute('name');
    // For inputs, check associated label
    if (['input','select','textarea'].includes(tag)) {
      const id = node.id;
      if (id) {
        const labelEl = document.querySelector('label[for="' + id + '"]');
        if (labelEl) return labelEl.textContent.trim();
      }
      if (name) return name;
      return '';
    }
    const text = (node.textContent || '').trim().slice(0, 60);
    return text || name || '';
  }

  return walk(body, 0);
})()`;

/**
 * Injected into page context — resolves a snapshot reference number
 * to a CSS selector that Playwright can target.
 *
 * Returns a unique selector string, or null if not found.
 */
const RESOLVE_REF_SCRIPT = `(refNum) => {
  const el = document.querySelector('[data-ref="' + refNum + '"]');
  if (!el) return null;
  // Build a unique selector using data-ref attribute
  return '[data-ref="' + refNum + '"]';
}`;
