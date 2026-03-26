/**
 * Visual browser interaction — uses screenshots + vision model to identify
 * and interact with page elements by visual appearance instead of DOM walking.
 *
 * This handles JS-heavy SPAs, shadow DOM, iframes, and any UI framework
 * because it works at the rendered pixel layer, not the DOM layer.
 *
 * Requires:
 * - Xvfb running on the host (e.g., `Xvfb :99 -screen 0 1280x720x24 &`)
 * - Browser launched non-headless against the Xvfb display
 * - A vision model available via Ollama (e.g., qwen3-vl:8b)
 */

import type { BrowserClient } from './client.js';

export interface VisualBrowserConfig {
  /** Ollama base URL for vision model calls */
  ollamaUrl: string;
  /** Vision model name (e.g., "qwen3-vl:8b") */
  visionModel: string;
  /** Fallback vision models to try if primary fails (e.g., ["qwen3.5:9b"]) */
  fallbackModels?: string[];
  /** Screenshot width */
  viewportWidth?: number;
  /** Screenshot height */
  viewportHeight?: number;
}

interface VisualElement {
  description: string;
  x: number;
  y: number;
  confidence: number;
}

/**
 * Take a screenshot and send it to the vision model for analysis.
 * Returns a text description of everything visible on the page,
 * including interactive elements and their approximate positions.
 */
export async function visualSnapshot(
  client: BrowserClient,
  config: VisualBrowserConfig,
  prompt?: string,
): Promise<string> {
  const screenshotBuf = await client.screenshot();
  const base64 = screenshotBuf.toString('base64');

  const visionPrompt = prompt ?? `Describe this web page screenshot in detail. List all visible interactive elements (buttons, links, input fields, menus, tabs) with their approximate position on the page (top-left, center, bottom-right, etc.). Be specific about text labels on each element.`;

  const response = await callVisionModel(config, base64, visionPrompt);
  return response;
}

/**
 * Find an element on the page by visual description and return its coordinates.
 * The vision model analyzes the screenshot and identifies where the target element is.
 */
export async function visualLocate(
  client: BrowserClient,
  config: VisualBrowserConfig,
  targetDescription: string,
): Promise<VisualElement | null> {
  const screenshotBuf = await client.screenshot();
  const base64 = screenshotBuf.toString('base64');

  const width = config.viewportWidth ?? 1280;
  const height = config.viewportHeight ?? 720;

  const prompt = `Look at this web page screenshot (${width}x${height} pixels).

Find the element that matches this description: "${targetDescription}"

Return ONLY a JSON object with these fields:
- "description": what the element looks like (its text label or visual appearance)
- "x": the X pixel coordinate of the element's center (0 = left edge, ${width} = right edge)
- "y": the Y pixel coordinate of the element's center (0 = top edge, ${height} = bottom edge)
- "confidence": how confident you are this is the right element (0.0 to 1.0)

If the element is not visible on the page, return: {"description": "not found", "x": 0, "y": 0, "confidence": 0}

Return ONLY the JSON object. No explanation.`;

  const raw = await callVisionModel(config, base64, prompt);

  // Parse the response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.x || !parsed.y || parsed.confidence === 0) return null;

    return {
      description: parsed.description ?? targetDescription,
      x: Math.round(parsed.x),
      y: Math.round(parsed.y),
      confidence: parsed.confidence ?? 0.5,
    };
  } catch {
    return null;
  }
}

/**
 * Click an element identified by visual description.
 * Takes a screenshot, asks the vision model where the target is, then clicks at those coordinates.
 */
export async function visualClick(
  client: BrowserClient,
  config: VisualBrowserConfig,
  targetDescription: string,
  tabId?: string,
): Promise<string> {
  const element = await visualLocate(client, config, targetDescription);
  if (!element) {
    return `Could not find "${targetDescription}" on the page. Try a more specific description or take a visual_snapshot first to see what's on the page.`;
  }

  if (element.confidence < 0.3) {
    return `Found a possible match for "${targetDescription}" at (${element.x}, ${element.y}) but confidence is low (${element.confidence}). Description: "${element.description}". Try a more specific description.`;
  }

  const page = (client as any).getPage(tabId);
  await page.mouse.click(element.x, element.y);

  // Wait for any navigation or dynamic content
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});

  console.log(`[VisualBrowser] Clicked "${targetDescription}" at (${element.x}, ${element.y}), confidence: ${element.confidence}`);

  return `Clicked "${element.description}" at coordinates (${element.x}, ${element.y}). Page: ${page.url()}`;
}

/**
 * Type text into an element identified by visual description.
 * Clicks the element first, then types.
 */
export async function visualType(
  client: BrowserClient,
  config: VisualBrowserConfig,
  targetDescription: string,
  text: string,
  tabId?: string,
): Promise<string> {
  const element = await visualLocate(client, config, targetDescription);
  if (!element) {
    return `Could not find "${targetDescription}" on the page.`;
  }

  const page = (client as any).getPage(tabId);

  // Click the field first to focus it
  await page.mouse.click(element.x, element.y);
  await new Promise(r => setTimeout(r, 200));

  // Clear existing content and type new text
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text, { delay: 30 });

  console.log(`[VisualBrowser] Typed into "${targetDescription}" at (${element.x}, ${element.y})`);

  return `Typed "${text}" into "${element.description}" at (${element.x}, ${element.y})`;
}

/**
 * Call the Ollama vision model with a base64 image and prompt.
 * Tries the primary model first, then falls back to alternatives (e.g., qwen3.5:9b).
 */
async function callVisionModel(
  config: VisualBrowserConfig,
  base64Image: string,
  prompt: string,
): Promise<string> {
  const models = [config.visionModel, ...(config.fallbackModels ?? [])];

  for (const model of models) {
    try {
      const result = await callSingleVisionModel(config.ollamaUrl, model, base64Image, prompt);
      if (result) {
        console.log(`[VisualBrowser] Vision model "${model}" responded (${result.length} chars)`);
        return result;
      }
      console.warn(`[VisualBrowser] Vision model "${model}" returned empty after retry`);
    } catch (err) {
      console.warn(`[VisualBrowser] Vision model "${model}" failed: ${err instanceof Error ? err.message : err}`);
      if (model === models[models.length - 1]) throw err; // Last model — rethrow
      console.log(`[VisualBrowser] Trying fallback model...`);
    }
  }

  return '(Vision model could not analyze the page. The models may be busy or the image too complex. Try again.)';
}

async function callSingleVisionModel(
  ollamaUrl: string,
  model: string,
  base64Image: string,
  prompt: string,
): Promise<string> {
  // Retry once on empty response (model cold-start or GPU contention)
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
            images: [base64Image],
          },
        ],
        stream: false,
        options: { num_predict: 1024 },
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      throw new Error(`Vision model "${model}" returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as {
      message?: { content?: string; thinking?: string };
      error?: { message?: string };
    };

    if (data.error) {
      throw new Error(`Vision model "${model}" error: ${data.error.message ?? JSON.stringify(data.error)}`);
    }

    const result = (data.message?.content || data.message?.thinking || '').trim();
    if (result) return result;

    if (attempt === 0) {
      console.log(`[VisualBrowser] Vision model "${model}" returned empty, retrying...`);
    }
  }

  return '';
}
