/**
 * Browser automation client using Playwright.
 * Provides tab management, navigation, snapshots, screenshots.
 */
export class BrowserClient {
  private browser: any = null;
  private pages = new Map<string, any>();
  private activeTabId = 'default';

  async launch(options?: { headless?: boolean; executablePath?: string }): Promise<void> {
    let pw: any;
    try {
      const mod = 'playwright-core';
      pw = await import(/* webpackIgnore: true */ mod);
    } catch {
      throw new Error('playwright-core not installed. Run: npm i playwright-core');
    }

    this.browser = await pw.chromium.launch({
      headless: options?.headless ?? true,
      executablePath: options?.executablePath,
    });

    const context = await this.browser.newContext();
    const page = await context.newPage();
    this.pages.set('default', page);
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
    return page.url();
  }

  async snapshot(tabId?: string): Promise<string> {
    const page = this.getPage(tabId);
    const title = await page.title();
    const url = page.url();

    // AI-friendly text snapshot via injected JS (avoids DOM types in Node)
    const text: string = await page.evaluate(SNAPSHOT_SCRIPT);

    return `Page: ${title}\nURL: ${url}\n\n${text.slice(0, 10000)}`;
  }

  async screenshot(tabId?: string): Promise<Buffer> {
    const page = this.getPage(tabId);
    return page.screenshot({ type: 'png', fullPage: false });
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

  private getPage(tabId?: string): any {
    const id = tabId ?? this.activeTabId;
    const page = this.pages.get(id);
    if (!page) throw new Error(`Tab "${id}" not found`);
    return page;
  }
}

/** Injected into page context — uses browser DOM APIs directly. */
const SNAPSHOT_SCRIPT = `(() => {
  const body = document.body;
  if (!body) return '(empty page)';
  function walk(node, depth) {
    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (['script','style','noscript'].includes(tag)) return '';
    const lines = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = (child.textContent || '').trim();
        if (t) lines.push(t);
      } else if (child.nodeType === 1) {
        lines.push(walk(child, depth + 1));
      }
    }
    const content = lines.filter(Boolean).join('\\n');
    if (!content) return '';
    if (['h1','h2','h3','h4'].includes(tag)) return '[' + tag + '] ' + content;
    if (tag === 'a') return '[link: ' + (node.href || '') + '] ' + content;
    if (tag === 'button') return '[button] ' + content;
    if (tag === 'input') return '[input: ' + (node.type || 'text') + ']';
    return content;
  }
  return walk(body, 0);
})()`;
