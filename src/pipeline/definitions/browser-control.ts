import type { PipelineDefinition } from '../types.js';
import { remoteBridge } from '../../browser/remote-bridge.js';

/**
 * Browser control pipeline: plan → execute → synthesize
 *
 * LLM generates a step plan, code executes each step via the remote browser
 * bridge (Chrome extension), LLM synthesizes the collected data into a final answer.
 *
 * Pattern: LLM plans, code executes, LLM interprets. Same as analytics/heartbeat.
 */

interface BrowserStep {
  action: string;
  url?: string;
  ref?: string;
  text?: string;
  purpose: string;
}

/** Execute a single browser action via the remote bridge */
async function executeBrowserAction(action: string, params: Record<string, string | undefined>): Promise<string> {
  try {
    const result = await remoteBridge.sendAction({
      action,
      url: params.url,
      ref: params.ref,
      text: params.text,
      direction: params.direction,
    });

    // Navigate needs time for page load + content script injection
    if (action === 'navigate') {
      await new Promise(r => setTimeout(r, 3000));
    }

    return result;
  } catch (err) {
    return `Action failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Take a snapshot, auto-fallback to screenshot+vision if sparse */
async function readPage(client: import('../../ollama/client.js').OllamaClient, visionModel: string): Promise<string> {
  // Try snapshot first (fast, structured)
  const snapshot = await executeBrowserAction('snapshot', {});

  // If sparse (JS-heavy site), auto-screenshot with vision
  if (snapshot.length < 500 && !snapshot.includes('Action failed')) {
    console.log(`[BrowserControl] Sparse snapshot (${snapshot.length} chars) — auto-vision`);
    try {
      const dataUrl = await remoteBridge.sendAction({ action: 'screenshot' });
      if (dataUrl && dataUrl.startsWith('data:image')) {
        const base64 = dataUrl.split(',')[1];
        if (base64) {
          const response = await client.chat({
            model: visionModel,
            messages: [{
              role: 'user',
              content: 'Describe what you see on this page. List every product name, price, and vendor visible. Be specific and thorough.',
              images: [base64],
            }],
            options: { temperature: 0.3, num_predict: 4096 },
          });
          const vision = response.message?.content;
          if (vision) return snapshot + '\n\n[VISUAL DESCRIPTION]\n' + vision;
        }
      }
    } catch (err) {
      console.warn('[BrowserControl] Auto-vision failed:', err instanceof Error ? err.message : err);
    }
  }

  return snapshot;
}

export const browserControlPipeline: PipelineDefinition = {
  name: 'browser_control',
  stages: [
    // Stage 0: Extract intent and page context
    {
      name: 'extract_intent',
      type: 'code',
      execute: async (ctx) => {
        // Strip page tokens, keep the actual request
        const pageMatch = ctx.userMessage.match(/\[PAGE:\s*([^\]|]+)\s*\|\s*([^\]]+)\]/);
        ctx.params.pageUrl = pageMatch?.[1]?.trim() ?? '';
        ctx.params.pageTitle = pageMatch?.[2]?.trim() ?? '';
        ctx.userMessage = ctx.userMessage
          .replace(/\[PAGE:[^\]]*\]/g, '')
          .replace(/\[SELECTED:[^\]]*\]/g, '')
          .replace(/\[PAGE_CONTENT\][\s\S]*?\[\/PAGE_CONTENT\]/g, '')
          .trim();
        return ctx.userMessage;
      },
    },

    // Stage 1: LLM generates a step plan
    {
      name: 'generate_plan',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 2048,
      buildPrompt: (ctx) => {
        const pageUrl = ctx.params.pageUrl as string;
        const pageTitle = ctx.params.pageTitle as string;

        return {
          system: `You are a browser automation planner. Given a user request, output a JSON array of steps to accomplish it.

AVAILABLE ACTIONS:
- navigate: Go to a URL. ALWAYS prefer direct URLs (e.g., google.com/search?q=...) over multi-step UI interaction.
- read_page: Read the current page content. Automatically uses vision for JS-heavy sites.
- scroll: Scroll down to see more content.
- click: Click an element by ref number or text description.
- type: Type text into an input field.
- pressKey: Press a key (Enter, Tab, Escape).

RULES:
- Maximum 8 steps.
- Use direct URLs whenever possible (google.com/search?q=, amazon.com/s?k=, etc.)
- read_page once per page is enough. Don't plan multiple reads of the same page.
- If the task is research across multiple sites, navigate to each site directly.
- End with a step that has action "synthesize" — this is where results get compiled.

Output ONLY valid JSON. No explanation.

Example:
[
  {"action": "navigate", "url": "https://www.google.com/search?q=A6000+GPU+prices", "purpose": "Search for A6000 GPU prices"},
  {"action": "read_page", "purpose": "Extract search results with prices and vendors"},
  {"action": "navigate", "url": "https://www.ebay.com/sch/i.html?_nkw=A6000+GPU", "purpose": "Check eBay listings"},
  {"action": "read_page", "purpose": "Extract eBay listings with prices"},
  {"action": "synthesize", "purpose": "Compile price comparison from all sources"}
]`,
          user: `Current page: ${pageUrl} (${pageTitle})

User request: ${ctx.userMessage}`,
        };
      },
    },

    // Stage 2: Parse the plan
    {
      name: 'parse_plan',
      type: 'code',
      execute: async (ctx) => {
        const raw = ctx.stageResults.generate_plan as string;
        // Extract JSON from response (may have thinking tags or markdown)
        const cleaned = raw
          .replace(/<think>[\s\S]*?<\/think>/g, '')
          .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '')
          .trim();
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          console.warn('[BrowserControl] Could not parse plan, using simple navigate+read');
          ctx.params.steps = [
            { action: 'read_page', purpose: 'Read current page' },
            { action: 'synthesize', purpose: 'Summarize findings' },
          ];
          return 'Fallback plan: read + synthesize';
        }

        try {
          const steps = JSON.parse(jsonMatch[0]) as BrowserStep[];
          // Cap at 8 steps + ensure synthesize is last
          const capped = steps.filter(s => s.action !== 'synthesize').slice(0, 7);
          capped.push({ action: 'synthesize' as any, purpose: 'Compile final answer' });
          ctx.params.steps = capped;
          console.log(`[BrowserControl] Plan: ${capped.length} steps`);
          return `Plan: ${capped.map((s, i) => `${i + 1}. ${s.action}${s.url ? ' → ' + s.url : ''}: ${s.purpose}`).join('\n')}`;
        } catch {
          ctx.params.steps = [
            { action: 'read_page', purpose: 'Read current page' },
            { action: 'synthesize', purpose: 'Summarize findings' },
          ];
          return 'Fallback plan: read + synthesize';
        }
      },
    },

    // Stage 3: Execute each step
    {
      name: 'execute_steps',
      type: 'code',
      execute: async (ctx) => {
        const steps = ctx.params.steps as BrowserStep[];
        const results: string[] = [];
        const visionModel = 'qwen3.6:35b';

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (step.action === 'synthesize') continue; // handled by next stage

          console.log(`[BrowserControl] Step ${i + 1}/${steps.length}: ${step.action}${step.url ? ' → ' + step.url : ''}`);

          try {
            let result: string;

            switch (step.action) {
              case 'navigate':
                if (!step.url) { results.push(`Step ${i + 1}: No URL provided`); continue; }
                await executeBrowserAction('navigate', { url: step.url });
                // Auto-read after navigate
                result = await readPage(ctx.client, visionModel);
                break;

              case 'read_page':
                result = await readPage(ctx.client, visionModel);
                break;

              case 'scroll':
                await executeBrowserAction('scroll', { direction: 'down' });
                // Auto-read after scroll
                result = await readPage(ctx.client, visionModel);
                break;

              case 'click':
                result = await executeBrowserAction('click', { ref: step.ref ?? step.text });
                break;

              case 'type':
                result = await executeBrowserAction('type', { ref: step.ref, text: step.text });
                break;

              case 'pressKey':
                result = await executeBrowserAction('pressKey', { text: step.text ?? 'Enter' });
                break;

              default:
                result = `Unknown action: ${step.action}`;
            }

            if (result.includes('Action failed')) {
              console.warn(`[BrowserControl] Step ${i + 1} failed — skipping`);
              results.push(`Step ${i + 1} (${step.purpose}): FAILED — ${result}`);
            } else {
              results.push(`Step ${i + 1} (${step.purpose}):\n${result}`);
            }
          } catch (err) {
            console.warn(`[BrowserControl] Step ${i + 1} error:`, err instanceof Error ? err.message : err);
            results.push(`Step ${i + 1} (${step.purpose}): ERROR — ${err instanceof Error ? err.message : err}`);
          }
        }

        ctx.stageResults.collectedData = results.join('\n\n---\n\n');
        return `Executed ${results.length} steps`;
      },
    },

    // Stage 4: LLM synthesizes all collected data into final answer
    {
      name: 'synthesize',
      type: 'llm',
      stream: true,
      temperature: 0.3,
      maxTokens: 8192,
      buildPrompt: (ctx) => {
        const data = ctx.stageResults.collectedData as string;

        return {
          system: `You are a research analyst. A browser automation pipeline has visited web pages and collected data for you. Synthesize the data into a clear, comprehensive answer.

RULES:
- Use ONLY data from the collected results below — never invent.
- Include specific numbers (prices, ratings, counts).
- Include URLs where available.
- Format with markdown tables or bullet lists for readability.
- If data is incomplete or some steps failed, note what's missing.
- Be thorough but concise.`,
          user: `User's original request: "${ctx.userMessage}"

Collected data from browser automation:

${data}`,
        };
      },
    },
  ],
};
