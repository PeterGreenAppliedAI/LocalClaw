import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalClawTool } from './types.js';
import { BrowserClient } from '../browser/client.js';
import type { BrowserConfig } from '../config/types.js';
import { visualSnapshot, type VisualBrowserConfig } from '../browser/visual.js';

let sharedClient: BrowserClient | null = null;

const MEDIA_DIR = 'data/media/browser';

export function createBrowserTool(config?: BrowserConfig, ollamaUrl?: string): LocalClawTool {
  // Build visual config for automatic escalation (only used when DOM fails)
  // Enable when display is set (Xvfb) OR when running headed (real display)
  const visualConfig: VisualBrowserConfig | null = (config?.display || config?.headless === false)
    ? {
        ollamaUrl: ollamaUrl ?? 'http://127.0.0.1:11434',
        visionModel: config.visionModel ?? 'qwen3.5:35b',
        fallbackModels: ['qwen3.5:9b', 'qwen3-vl:8b'],
        viewportWidth: 1280,
        viewportHeight: 720,
      }
    : null;

  return {
    name: 'browser',
    description: `Control a web browser: navigate pages, read content, fill forms, click buttons.

Use "snapshot" to see the page with numbered interactive elements.
Use "text_content" to read rendered text from the page (better for SPAs).
Then use "click", "type", or "select" with the element number to interact.
If DOM interaction fails, the browser automatically escalates to visual mode (vision model + coordinate clicking).

Workflow: open → navigate → snapshot/text_content → click/type by number → verify → repeat.`,
    parameterDescription: `action (required): "open" | "navigate" | "snapshot" | "text_content" | "screenshot" | "click" | "type" | "select" | "wait" | "tabs" | "close".
url (optional): URL for navigate/open.
ref (optional): Element reference number from snapshot, CSS selector, or text description of element. Used by click/type/select. If DOM lookup fails, text descriptions trigger automatic visual fallback.
text (optional): Text to type (for "type" action) or option to select (for "select" action).
tab (optional): Tab ID.`,
    example: 'browser[{"action": "click", "ref": "3"}]',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Browser action to perform',
          enum: [
            'open', 'navigate', 'snapshot', 'text_content', 'screenshot',
            'click', 'type', 'select', 'wait',
            'visual_snapshot',
            'tabs', 'console', 'pdf', 'close',
          ],
        },
        url: { type: 'string', description: 'URL for navigate/open actions' },
        ref: { type: 'string', description: 'Element number, CSS selector, or text description (auto-escalates to visual if DOM fails)' },
        text: { type: 'string', description: 'Text to type or option to select' },
        tab: { type: 'string', description: 'Tab ID to target' },
      },
      required: ['action'],
    },
    category: 'web_search',

    async execute(params: Record<string, unknown>): Promise<string> {
      const action = params.action as string;
      if (!action) return 'Error: action parameter is required';

      // Lazy-init browser — auto-launch if not running
      if (!sharedClient || !sharedClient.isRunning()) {
        if (action === 'close') {
          return 'Browser is already closed.';
        }

        sharedClient = new BrowserClient();
        try {
          await sharedClient.launch({
            headless: config?.display ? false : (config?.headless ?? true),
            executablePath: config?.executablePath,
            display: config?.display,
          });
          // Wire visual config for automatic escalation
          sharedClient.visualConfig = visualConfig;
          console.log('[Browser] Auto-launched');
        } catch (err) {
          return `Error launching browser: ${err instanceof Error ? err.message : err}`;
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
              return `Browser opened and navigated to ${url}. Take a snapshot to see the page elements.`;
            }
            return 'Browser launched';
          }
          case 'navigate': {
            const url = params.url as string;
            if (!url) return 'Error: url parameter required for navigate';
            const finalUrl = await client.navigate(url, tab);
            return `Navigated to ${finalUrl}. Take a snapshot to see the page elements.`;
          }
          case 'snapshot': {
            return await client.snapshot(tab);
          }
          case 'text_content': {
            return await client.textContent(tab);
          }
          case 'screenshot': {
            const buf = await client.screenshot(tab);
            mkdirSync(MEDIA_DIR, { recursive: true });
            const filename = `screenshot-${Date.now()}.png`;
            const filepath = join(MEDIA_DIR, filename);
            writeFileSync(filepath, buf);
            return `Screenshot saved.\n[IMAGE:${filepath}]`;
          }
          case 'click': {
            const ref = params.ref as string;
            if (!ref) return 'Error: ref parameter required for click (element number, CSS selector, or text description)';
            // DOM-first with automatic visual escalation (handled inside client.click)
            return await client.click(ref, tab);
          }
          case 'type': {
            const ref = params.ref as string;
            const text = params.text as string;
            if (!ref) return 'Error: ref parameter required for type';
            if (!text) return 'Error: text parameter required for type';
            // DOM-first with automatic visual escalation
            return await client.type(ref, text, tab);
          }
          case 'select': {
            const ref = params.ref as string;
            const text = params.text as string;
            if (!ref) return 'Error: ref parameter required for select';
            if (!text) return 'Error: text parameter required for select (option value)';
            return await client.select(ref, text, tab);
          }
          case 'wait': {
            const ref = params.ref as string;
            if (!ref) return 'Error: ref parameter required for wait (CSS selector)';
            return await client.waitFor(ref, 10_000, tab);
          }

          // Visual snapshot still available as explicit action for when you
          // specifically want the vision model's take on the page
          case 'visual_snapshot': {
            if (!visualConfig) return 'Visual mode not configured. Set browser.display in config to enable.';
            const prompt = params.text as string | undefined;
            return await visualSnapshot(client, visualConfig, prompt);
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
            return `Unknown action: ${action}. Use: open, navigate, snapshot, text_content, click, type, select, wait, screenshot, tabs, close`;
        }
      } catch (err) {
        return `Browser error: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}
