import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalClawTool } from './types.js';
import { BrowserClient } from '../browser/client.js';
import type { BrowserConfig } from '../config/types.js';
import { visualSnapshot, type VisualBrowserConfig } from '../browser/visual.js';
import { remoteBridge } from '../browser/remote-bridge.js';

let sharedClient: BrowserClient | null = null;

/** Capture visible tab screenshot and describe with vision model */
async function captureAndDescribe(
  bridge: typeof remoteBridge,
  ollamaUrl?: string,
  visionModel?: string,
): Promise<string | null> {
  const dataUrl = await bridge.sendAction({ action: 'screenshot' });
  if (!dataUrl || !dataUrl.startsWith('data:image')) {
    console.warn(`[Browser] Screenshot returned invalid data: ${typeof dataUrl} (${dataUrl?.slice(0, 100)})`);
    return null;
  }

  const base64 = dataUrl.split(',')[1];
  if (!base64) return null;

  const model = visionModel ?? 'qwen3.6:35b';
  const response = await fetch(`${ollamaUrl ?? 'http://127.0.0.1:11434'}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: 'Describe what you see on this page. List every product name, price, and vendor visible. Be specific and thorough.',
        images: [base64],
      }],
      stream: false,
      options: { temperature: 0.3, num_predict: 4096 },
    }),
  });
  const json = await response.json() as { message?: { content?: string } };
  return json.message?.content ?? null;
}

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
Then use "click", "type", "select", or "pressKey" with the element number to interact.
After typing into a search field, use "pressKey" with text="Enter" to submit.
If DOM interaction fails, the browser automatically escalates to visual mode (vision model + coordinate clicking).

Workflow: open → navigate → snapshot → click/type by number → pressKey Enter to submit → snapshot to verify → repeat.`,
    parameterDescription: `action (required): "open" | "navigate" | "snapshot" | "text_content" | "screenshot" | "click" | "type" | "select" | "pressKey" | "wait" | "tabs" | "close".
url (optional): URL for navigate/open.
ref (optional): Element reference number from snapshot, CSS selector, or text description of element. Used by click/type/select/pressKey.
text (optional): Text to type (for "type"), option to select (for "select"), or key name (for "pressKey" — e.g., "Enter", "Tab", "Escape").
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
            'click', 'type', 'select', 'wait', 'pressKey',
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

    async execute(params: Record<string, unknown>, ctx): Promise<string> {
      const action = params.action as string;
      if (!action) return 'Error: action parameter is required';

      // Remote extension bridge — only for extension (console channel), never for Discord/Telegram/etc.
      if (remoteBridge.isConnected() && ctx?.channel === 'console') {
        // Actions that don't need forwarding
        if (action === 'open' && !params.url) return 'Connected to Chrome extension. Take a snapshot to see page elements.';
        // open with URL = navigate
        if (action === 'open' && params.url) {
          try {
            const result = await remoteBridge.sendAction({ action: 'navigate', url: params.url as string });
            await new Promise(r => setTimeout(r, 3000));
            return result;
          } catch (err) {
            return `Extension browser action failed: ${err instanceof Error ? err.message : err}`;
          }
        }
        if (action === 'close') return 'Browser controlled by extension — cannot close.';
        if (action === 'tabs') return 'Tab management not available in extension mode.';

        // Screenshot: capture tab → send to vision model for description
        if (action === 'screenshot' || action === 'visual_snapshot') {
          try {
            const result = await captureAndDescribe(remoteBridge, ollamaUrl, config?.visionModel);
            return result ?? 'Screenshot capture failed';
          } catch (err) {
            console.warn(`[Browser] Screenshot/vision error:`, err instanceof Error ? err.message : err);
            return `Screenshot/vision failed: ${err instanceof Error ? err.message : err}`;
          }
        }

        try {
          const result = await remoteBridge.sendAction({
            action,
            ref: params.ref as string | undefined,
            text: params.text as string | undefined,
            url: params.url as string | undefined,
            direction: params.direction as string | undefined,
            selector: params.ref as string | undefined,
          });
          // Navigate changes the page — wait for new content script to load
          if (action === 'navigate') {
            await new Promise(r => setTimeout(r, 3000));
          }
          // Auto-vision: if snapshot/text_content looks sparse (JS-heavy site), auto-take screenshot
          if ((action === 'snapshot' || action === 'text_content') && result.length < 500) {
            console.log(`[Browser] Sparse ${action} result (${result.length} chars) — auto-triggering vision screenshot`);
            try {
              const visionResult = await captureAndDescribe(remoteBridge, ollamaUrl, config?.visionModel);
              if (visionResult) return result + '\n\n[VISUAL DESCRIPTION of what is actually rendered on screen:]\n' + visionResult;
            } catch (vErr) {
              console.warn('[Browser] Auto-vision failed:', vErr instanceof Error ? vErr.message : vErr);
            }
          }
          return result;
        } catch (err) {
          return `Extension browser action failed: ${err instanceof Error ? err.message : err}`;
        }
      }

      // Fallback: local Playwright browser
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
