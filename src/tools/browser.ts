import type { LocalClawTool } from './types.js';
import { BrowserClient } from '../browser/client.js';
import type { BrowserConfig } from '../config/types.js';

let sharedClient: BrowserClient | null = null;

export function createBrowserTool(config?: BrowserConfig): LocalClawTool {
  return {
    name: 'browser',
    description: 'Control a web browser: navigate, take snapshots, screenshots, interact with pages',
    parameterDescription: 'action (required): "open" | "navigate" | "snapshot" | "screenshot" | "tabs" | "close". url (optional): URL for navigate/open. tab (optional): Tab ID.',
    example: 'browser[{"action": "navigate", "url": "https://example.com/dashboard"}]',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Browser action to perform', enum: ['open', 'navigate', 'snapshot', 'screenshot', 'tabs', 'console', 'pdf', 'close'] },
        url: { type: 'string', description: 'URL for navigate/open actions' },
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
        if (action === 'close' || action === 'tabs' || action === 'snapshot' || action === 'screenshot') {
          if (!sharedClient?.isRunning()) {
            return 'Browser is not running. Use action "open" first.';
          }
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
            return `Unknown action: ${action}. Use: open, navigate, snapshot, screenshot, tabs, console, pdf, close`;
        }
      } catch (err) {
        return `Browser error: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}
