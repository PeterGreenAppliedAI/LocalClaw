import type { LocalClawTool } from './types.js';
import { BrowserClient } from '../browser/client.js';
import type { BrowserConfig } from '../config/types.js';
import { visualSnapshot, visualClick, visualType, type VisualBrowserConfig } from '../browser/visual.js';

let sharedClient: BrowserClient | null = null;

export function createBrowserTool(config?: BrowserConfig, ollamaUrl?: string): LocalClawTool {
  // Build visual config if display is configured
  const visualConfig: VisualBrowserConfig | null = config?.display
    ? {
        ollamaUrl: ollamaUrl ?? 'http://127.0.0.1:11434',
        visionModel: config.visionModel ?? 'qwen3-vl:8b',
        fallbackModels: ['qwen3-vl:8b'],
        viewportWidth: 1280,
        viewportHeight: 720,
      }
    : null;

  return {
    name: 'browser',
    description: `Control a web browser: navigate pages, read content, fill forms, click buttons.

DOM mode (default): Use "snapshot" to see numbered interactive elements, then "click"/"type"/"select" by number.
Visual mode (if configured): Use "visual_snapshot" to see the page through a vision model, then "visual_click"/"visual_type" by describing the element.

Workflow: open → navigate → snapshot/visual_snapshot → interact → verify → repeat.`,
    parameterDescription: `action (required): "open" | "navigate" | "snapshot" | "screenshot" | "click" | "type" | "select" | "visual_snapshot" | "visual_click" | "visual_type" | "wait" | "tabs" | "close".
url (optional): URL for navigate/open.
ref (optional): Element reference number from snapshot, or CSS selector. Used by click/type/select.
text (optional): Text to type, option to select, or element description for visual actions.
target (optional): Visual description of element to interact with (for visual_click/visual_type).
tab (optional): Tab ID.`,
    example: 'browser[{"action": "visual_click", "target": "Events tab in the navigation menu"}]',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Browser action to perform',
          enum: [
            'open', 'navigate', 'snapshot', 'screenshot',
            'click', 'type', 'select', 'wait',
            'visual_snapshot', 'visual_click', 'visual_type',
            'tabs', 'console', 'pdf', 'close',
          ],
        },
        url: { type: 'string', description: 'URL for navigate/open actions' },
        ref: { type: 'string', description: 'Element reference number from snapshot, or CSS selector' },
        text: { type: 'string', description: 'Text to type or option to select' },
        target: { type: 'string', description: 'Visual description of element (for visual_click/visual_type)' },
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
        const needsRunning = [
          'close', 'tabs', 'snapshot', 'screenshot', 'click', 'type', 'select', 'wait',
          'visual_snapshot', 'visual_click', 'visual_type',
        ];
        if (needsRunning.includes(action)) {
          return 'Browser is not running. Use action "open" first.';
        }

        if (action === 'open' || action === 'navigate') {
          sharedClient = new BrowserClient();
          try {
            await sharedClient.launch({
              headless: config?.display ? false : (config?.headless ?? true),
              executablePath: config?.executablePath,
              display: config?.display,
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
          // ── Standard DOM-based actions ──
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
          case 'text_content': {
            return await client.textContent(tab);
          }
          case 'click': {
            const ref = params.ref as string;
            if (!ref) return 'Error: ref parameter required for click (element number from snapshot or CSS selector)';
            return await client.click(ref, tab);
          }
          case 'type': {
            const ref = params.ref as string;
            const text = params.text as string;
            if (!ref) return 'Error: ref parameter required for type';
            if (!text) return 'Error: text parameter required for type';
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

          // ── Visual mode actions (vision model + coordinate clicking) ──
          case 'visual_snapshot': {
            if (!visualConfig) return 'Visual mode not configured. Set browser.display in config to enable (requires Xvfb).';
            const prompt = params.text as string | undefined;
            return await visualSnapshot(client, visualConfig, prompt);
          }
          case 'visual_click': {
            if (!visualConfig) return 'Visual mode not configured. Set browser.display in config to enable (requires Xvfb).';
            const target = (params.target ?? params.text) as string;
            if (!target) return 'Error: target parameter required for visual_click (describe the element to click)';
            return await visualClick(client, visualConfig, target, tab);
          }
          case 'visual_type': {
            if (!visualConfig) return 'Visual mode not configured. Set browser.display in config to enable (requires Xvfb).';
            const target = params.target as string;
            const text = params.text as string;
            if (!target) return 'Error: target parameter required for visual_type (describe the input field)';
            if (!text) return 'Error: text parameter required for visual_type';
            return await visualType(client, visualConfig, target, text, tab);
          }

          // ── Utility actions ──
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
            return `Unknown action: ${action}. Use: open, navigate, snapshot, click, type, select, visual_snapshot, visual_click, visual_type, wait, screenshot, tabs, close`;
        }
      } catch (err) {
        return `Browser error: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}
