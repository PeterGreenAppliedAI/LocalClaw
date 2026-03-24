import type { LocalClawTool } from './types.js';
import { BrowserClient } from '../browser/client.js';
import type { BrowserConfig } from '../config/types.js';

let sharedClient: BrowserClient | null = null;

export function createBrowserTool(config?: BrowserConfig): LocalClawTool {
  return {
    name: 'browser',
    description: `Control a web browser: navigate pages, read content, fill forms, click buttons.
Use "snapshot" to see the page with numbered interactive elements.
Then use "click", "type", or "select" with the element number to interact.
Workflow: open → navigate → snapshot → interact → snapshot (verify) → repeat.`,
    parameterDescription: `action (required): "open" | "navigate" | "snapshot" | "screenshot" | "click" | "type" | "select" | "wait" | "tabs" | "close".
url (optional): URL for navigate/open.
ref (optional): Element reference number from snapshot, or CSS selector. Used by click/type/select.
text (optional): Text to type (for "type" action) or option to select (for "select" action).
tab (optional): Tab ID.`,
    example: 'browser[{"action": "click", "ref": "3"}]',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Browser action to perform',
          enum: ['open', 'navigate', 'snapshot', 'screenshot', 'click', 'type', 'select', 'wait', 'tabs', 'console', 'pdf', 'close'],
        },
        url: { type: 'string', description: 'URL for navigate/open actions' },
        ref: { type: 'string', description: 'Element reference number from snapshot, or CSS selector' },
        text: { type: 'string', description: 'Text to type or option to select' },
        tab: { type: 'string', description: 'Tab ID to target' },
      },
      required: ['action'],
    },
    category: 'web_search',

    async execute(params: Record<string, unknown>): Promise<string> {
      const action = params.action as string;
      if (!action) return 'Error: action parameter is required';

      // Lazy-init browser
      if (!sharedClient || !sharedClient.isRunning()) {
        const needsRunning = ['close', 'tabs', 'snapshot', 'screenshot', 'click', 'type', 'select', 'wait'];
        if (needsRunning.includes(action)) {
          return 'Browser is not running. Use action "open" first.';
        }

        if (action === 'open' || action === 'navigate') {
          sharedClient = new BrowserClient();
          try {
            await sharedClient.launch({
              headless: config?.headless ?? true,
              executablePath: config?.executablePath,
            });
          } catch (err) {
            return `Error launching browser: ${err instanceof Error ? err.message : err}`;
          }
        }
      }

      const client = sharedClient!;
      const tab = params.tab as string | undefined;

      try {
        switch (action) {
          case 'open': {
            const url = params.url as string;
            if (url) {
              await client.navigate(url, tab);
              return `Browser opened and navigated to ${url}`;
            }
            return 'Browser launched';
          }
          case 'navigate': {
            const url = params.url as string;
            if (!url) return 'Error: url parameter required for navigate';
            const finalUrl = await client.navigate(url, tab);
            return `Navigated to ${finalUrl}`;
          }
          case 'snapshot': {
            return await client.snapshot(tab);
          }
          case 'screenshot': {
            const buf = await client.screenshot(tab);
            return `Screenshot taken (${buf.length} bytes). [Binary data — use snapshot for text content]`;
          }
          case 'click': {
            const ref = params.ref as string;
            if (!ref) return 'Error: ref parameter required for click (element number from snapshot or CSS selector)';
            return await client.click(ref, tab);
          }
          case 'type': {
            const ref = params.ref as string;
            const text = params.text as string;
            if (!ref) return 'Error: ref parameter required for type (element number from snapshot or CSS selector)';
            if (!text) return 'Error: text parameter required for type';
            return await client.type(ref, text, tab);
          }
          case 'select': {
            const ref = params.ref as string;
            const text = params.text as string;
            if (!ref) return 'Error: ref parameter required for select (element number from snapshot or CSS selector)';
            if (!text) return 'Error: text parameter required for select (option value)';
            return await client.select(ref, text, tab);
          }
          case 'wait': {
            const ref = params.ref as string;
            if (!ref) return 'Error: ref parameter required for wait (CSS selector)';
            return await client.waitFor(ref, 10_000, tab);
          }
          case 'tabs': {
            const tabs = client.listTabs();
            return `Open tabs: ${tabs.join(', ')}`;
          }
          case 'console': {
            const msgs = await client.getConsole(tab);
            return msgs.join('\n') || '(no console output)';
          }
          case 'pdf': {
            const buf = await client.pdf(tab);
            return `PDF generated (${buf.length} bytes)`;
          }
          case 'close': {
            await client.close();
            sharedClient = null;
            return 'Browser closed';
          }
          default:
            return `Unknown action: ${action}. Use: open, navigate, snapshot, click, type, select, wait, screenshot, tabs, close`;
        }
      } catch (err) {
        return `Browser error: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}
