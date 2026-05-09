/**
 * Overnight background generation pipeline.
 * Generates slide backgrounds via Flux, reviews with qwen3.6, keeps good ones.
 *
 * Usage: npx tsx scripts/generate-backgrounds.ts [count]
 * Default: 50 backgrounds
 */

import { writeFileSync, mkdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const IMAGE_GEN_URL = process.env.IMAGE_GEN_URL ?? 'http://192.168.1.170:11434';
const IMAGE_GEN_MODEL = process.env.IMAGE_GEN_MODEL ?? 'x/flux2-klein:4b-fp8';
const REVIEW_URL = process.env.OLLAMA_URL ?? 'http://10.0.0.20:8001';
const REVIEW_MODEL = 'qwen3.6:35b';
const OUTPUT_DIR = 'data/assets/backgrounds';
const METADATA_FILE = join(OUTPUT_DIR, 'catalog.json');
const MIN_SCORE = 3;

interface BackgroundEntry {
  filename: string;
  prompt: string;
  category: string;
  palette: string;
  score: number;
  generatedAt: string;
}

// --- Prompt templates ---

const CATEGORIES = {
  'dark-gradient': [
    'Dark professional abstract background, deep {color1} and black gradient with subtle geometric grid lines, clean modern corporate presentation style, no text, 16:9',
    'Smooth dark gradient from {color1} to black, subtle noise texture, professional minimalist, no text, 16:9',
    'Dark abstract background with soft radial gradient from {color1} center fading to deep black edges, clean, no text, 16:9',
  ],
  'geometric': [
    'Dark background with subtle {color1} geometric wireframe shapes floating in space, low poly triangles, modern tech aesthetic, no text, 16:9',
    'Abstract dark background with interconnected {color1} nodes and lines forming a network graph pattern, futuristic, no text, 16:9',
    'Dark background with hexagonal grid pattern in subtle {color1}, fading edges, clean tech style, no text, 16:9',
  ],
  'particles': [
    'Dark abstract background with soft glowing {color1} particles scattered on black, bokeh effect, modern, no text, 16:9',
    'Dark background with floating {color1} light orbs and subtle particle trails, ethereal tech aesthetic, no text, 16:9',
    'Deep black background with tiny {color1} dots forming a constellation pattern, minimalist, no text, 16:9',
  ],
  'waves': [
    'Dark abstract background with smooth flowing {color1} wave lines on black, silk-like curves, modern, no text, 16:9',
    'Dark background with layered {color1} gradient waves, topographic style, professional, no text, 16:9',
    'Abstract dark background with gentle {color1} aurora-like bands across black sky, subtle glow, no text, 16:9',
  ],
  'texture': [
    'Dark brushed metal texture background with subtle {color1} tint, professional industrial, no text, 16:9',
    'Dark concrete texture background with subtle {color1} accent lighting from one side, moody professional, no text, 16:9',
    'Dark fabric-like texture background with fine weave pattern, subtle {color1} undertone, elegant, no text, 16:9',
  ],
  'light-corporate': [
    'Clean white and light gray gradient background with subtle {color1} accent line at bottom, professional corporate, no text, 16:9',
    'Soft light background with gentle {color1} to white gradient, clean modern business style, no text, 16:9',
    'White background with subtle {color1} geometric shapes in corners, minimal corporate design, no text, 16:9',
  ],
};

const PALETTES: Record<string, [string, string]> = {
  'blue': ['blue', '#2563eb'],
  'cyan': ['cyan', '#06b6d4'],
  'purple': ['purple', '#7c3aed'],
  'teal': ['teal', '#0d9488'],
  'indigo': ['indigo', '#4f46e5'],
  'emerald': ['emerald', '#059669'],
  'amber': ['amber', '#d97706'],
  'rose': ['rose', '#e11d48'],
  'slate': ['slate gray', '#64748b'],
};

function generatePrompts(count: number): Array<{ prompt: string; category: string; palette: string }> {
  const prompts: Array<{ prompt: string; category: string; palette: string }> = [];
  const categories = Object.keys(CATEGORIES);
  const paletteNames = Object.keys(PALETTES);

  let i = 0;
  while (prompts.length < count) {
    const cat = categories[i % categories.length];
    const templates = CATEGORIES[cat as keyof typeof CATEGORIES];
    const template = templates[i % templates.length];
    const paletteName = paletteNames[i % paletteNames.length];
    const [colorWord] = PALETTES[paletteName];

    prompts.push({
      prompt: template.replace(/\{color1\}/g, colorWord),
      category: cat,
      palette: paletteName,
    });
    i++;
  }

  return prompts;
}

async function generateImage(prompt: string, filename: string): Promise<boolean> {
  try {
    const res = await fetch(`${IMAGE_GEN_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_GEN_MODEL, prompt }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      console.error(`  [FAIL] HTTP ${res.status}`);
      return false;
    }

    const text = await res.text();
    const lines = text.trim().split('\n');
    let imageBase64: string | null = null;
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.image) imageBase64 = data.image;
      } catch { /* skip */ }
    }

    if (!imageBase64) {
      console.error('  [FAIL] No image data returned');
      return false;
    }

    const buffer = Buffer.from(imageBase64, 'base64');
    writeFileSync(filename, buffer);
    console.log(`  [OK] Generated ${Math.round(buffer.length / 1024)}KB`);
    return true;
  } catch (err) {
    console.error(`  [FAIL] ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function reviewImage(filepath: string): Promise<number> {
  try {
    const imageBuffer = readFileSync(filepath);
    const base64 = imageBuffer.toString('base64');

    const res = await fetch(`${REVIEW_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        messages: [{
          role: 'user',
          content: 'Rate this image as a presentation slide background on a scale of 1-5. Criteria: clean professional appearance, no text or artifacts, suitable as a background behind white text, visually appealing. Respond with ONLY a JSON: {"score": N, "reason": "brief reason"} /no_think',
          images: [base64],
        }],
        options: { temperature: 0.2, num_predict: 128 },
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      console.error(`  [REVIEW FAIL] HTTP ${res.status}`);
      return 0;
    }

    const data = await res.json() as any;
    const content = data.message?.content ?? '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error(`  [REVIEW FAIL] No JSON in response: ${content.slice(0, 100)}`);
      return 0;
    }

    const result = JSON.parse(match[0]);
    const score = typeof result.score === 'number' ? result.score : parseInt(result.score) || 0;
    console.log(`  [REVIEW] Score: ${score}/5 — ${result.reason ?? ''}`);
    return score;
  } catch (err) {
    console.error(`  [REVIEW FAIL] ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

async function main() {
  const count = parseInt(process.argv[2] ?? '50');
  console.log(`\nBackground Generation Pipeline`);
  console.log(`Generating ${count} backgrounds, reviewing with ${REVIEW_MODEL}`);
  console.log(`Output: ${OUTPUT_DIR}/\n`);

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Load existing catalog
  let catalog: BackgroundEntry[] = [];
  if (existsSync(METADATA_FILE)) {
    try { catalog = JSON.parse(readFileSync(METADATA_FILE, 'utf-8')); } catch { /* fresh start */ }
  }

  const prompts = generatePrompts(count);
  let generated = 0;
  let kept = 0;
  let rejected = 0;

  for (let i = 0; i < prompts.length; i++) {
    const { prompt, category, palette } = prompts[i];
    const filename = `bg_${category}_${palette}_${Date.now()}.png`;
    const filepath = join(OUTPUT_DIR, filename);

    console.log(`[${i + 1}/${count}] ${category}/${palette}`);
    console.log(`  Prompt: ${prompt.slice(0, 80)}...`);

    // Generate
    const ok = await generateImage(prompt, filepath);
    if (!ok) continue;
    generated++;

    // Review
    const score = await reviewImage(filepath);
    if (score >= MIN_SCORE) {
      catalog.push({
        filename,
        prompt,
        category,
        palette,
        score,
        generatedAt: new Date().toISOString(),
      });
      kept++;
      console.log(`  [KEPT] ✓`);
    } else {
      try { unlinkSync(filepath); } catch { /* best effort */ }
      rejected++;
      console.log(`  [REJECTED] Score ${score} < ${MIN_SCORE}`);
    }

    // Save catalog after each successful addition
    writeFileSync(METADATA_FILE, JSON.stringify(catalog, null, 2));
  }

  console.log(`\n--- Results ---`);
  console.log(`Generated: ${generated}`);
  console.log(`Kept: ${kept} (score >= ${MIN_SCORE})`);
  console.log(`Rejected: ${rejected}`);
  console.log(`Total in library: ${catalog.length}`);
  console.log(`Catalog: ${METADATA_FILE}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
