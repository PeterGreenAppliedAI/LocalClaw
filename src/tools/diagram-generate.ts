import { writeFileSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { LocalClawTool, ToolContext } from './types.js';
import type { z } from 'zod';
import type { ImageGenConfigSchema } from '../config/schema.js';
import { toolExecutionError } from '../errors.js';

type ImageGenConfig = z.infer<typeof ImageGenConfigSchema>;

// --- Theme definitions ---

interface ThemeConfig {
  fluxPrompt: string;
  boxBg: number[];          // RGBA
  boxBorder: number[];       // RGB
  textColor: number[];       // RGB
  titleColor: number[];      // RGB
  accentColor: number[];     // RGB
  connectionColor: number[]; // RGB
  sectionHeaderBg: number[]; // RGBA
  glowColor: number[] | null; // RGB or null for no glow
  fontFamily: string;
}

const THEMES: Record<string, ThemeConfig> = {
  cyberpunk: {
    fluxPrompt: 'dark cyberpunk cityscape background, neon purple and cyan lights, digital grid, abstract technology, no text, no people, 4k wallpaper',
    boxBg: [20, 10, 40, 180],
    boxBorder: [0, 255, 255],
    textColor: [220, 220, 255],
    titleColor: [0, 255, 255],
    accentColor: [255, 0, 200],
    connectionColor: [0, 200, 255],
    sectionHeaderBg: [0, 255, 255, 40],
    glowColor: [0, 255, 255],
    fontFamily: 'DejaVuSans-Bold',
  },
  corporate: {
    fluxPrompt: 'clean white abstract background, subtle light gray geometric patterns, professional business, no text, no people, 4k wallpaper',
    boxBg: [255, 255, 255, 220],
    boxBorder: [30, 58, 138],
    textColor: [30, 30, 30],
    titleColor: [30, 58, 138],
    accentColor: [59, 130, 246],
    connectionColor: [100, 116, 139],
    sectionHeaderBg: [30, 58, 138, 30],
    glowColor: null,
    fontFamily: 'DejaVuSans',
  },
  blueprint: {
    fluxPrompt: 'dark blue engineering blueprint background, white grid lines, technical schematic paper, no text, no people, 4k wallpaper',
    boxBg: [10, 30, 80, 180],
    boxBorder: [100, 180, 255],
    textColor: [200, 220, 255],
    titleColor: [255, 255, 255],
    accentColor: [100, 200, 255],
    connectionColor: [80, 160, 240],
    sectionHeaderBg: [100, 180, 255, 30],
    glowColor: [100, 180, 255],
    fontFamily: 'DejaVuSansMono',
  },
  minimal: {
    fluxPrompt: 'solid light gray background, subtle paper noise texture, clean minimalist, no text, no people, 4k wallpaper',
    boxBg: [245, 245, 245, 230],
    boxBorder: [60, 60, 60],
    textColor: [30, 30, 30],
    titleColor: [0, 0, 0],
    accentColor: [100, 100, 100],
    connectionColor: [120, 120, 120],
    sectionHeaderBg: [0, 0, 0, 15],
    glowColor: null,
    fontFamily: 'DejaVuSans',
  },
};

// --- Python rendering template ---
// Placeholders: __DIAGRAM_SPEC__, __THEME_CONFIG__, __BACKGROUND_PATH__, __OUTPUT_PATH__

const PYTHON_TEMPLATE = `
import json, os, sys, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

with open('__SPEC_PATH__') as f: SPEC = json.load(f)
with open('__THEME_PATH__') as f: THEME = json.load(f)
BG_PATH = '__BACKGROUND_PATH__'
OUT_PATH = '__OUTPUT_PATH__'

WIDTH, HEIGHT = 1920, 1080

# --- Font loading with fallback chain ---
def load_font(name, size):
    search = [
        f'/opt/homebrew/share/fonts/truetype/dejavu/{name}.ttf',
        f'/usr/share/fonts/truetype/dejavu/{name}.ttf',
        f'/usr/share/fonts/TTF/{name}.ttf',
        f'/System/Library/Fonts/Supplemental/{name}.ttf',
    ]
    for p in search:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except: continue
    try: return ImageFont.truetype(name, size)
    except: pass
    return ImageFont.load_default(size=size)

font_name = THEME.get('fontFamily', 'DejaVuSans-Bold')
font_plain = font_name.replace('-Bold', '')
title_font = load_font(font_name, 56)
subtitle_font = load_font(font_plain, 28)
section_font = load_font(font_name, 22)
item_font = load_font(font_plain, 17)
tagline_font = load_font(font_plain, 18)
conn_font = load_font(font_plain, 15)

# --- Load and resize background ---
bg = Image.open(BG_PATH).resize((WIDTH, HEIGHT), Image.LANCZOS)
canvas = bg.convert('RGBA')

# Darken background for better text contrast
dark = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 120))
canvas = Image.alpha_composite(canvas, dark)

overlay = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
draw = ImageDraw.Draw(overlay)

# --- Measure text width helper ---
def text_width(text, font):
    bbox = font.getbbox(text)
    return bbox[2] - bbox[0]

# --- Layout engine: content-fit sizing ---
def compute_layout(sections):
    rows = {'top': [], 'middle': [], 'bottom': [], 'left': [], 'right': []}
    for s in sections:
        pos = s.get('position', 'middle')
        rows[pos].append(s)

    positions = {}
    margin = 50
    gap = 24
    title_space = 120 if SPEC.get('subtitle') else 90
    tagline_space = 50 if SPEC.get('tagline') else 20
    usable_h = HEIGHT - title_space - tagline_space
    usable_w = WIDTH - margin * 2

    # Measure each section's natural width based on content
    def measure_section(s):
        label_w = text_width(s.get('label', ''), section_font) + 32
        max_item_w = max((text_width(str(it), item_font) for it in s.get('items', [''])), default=100) + 40
        w = max(label_w, max_item_w, 180)
        item_count = len(s.get('items', []))
        h = 52 + item_count * 36 + 16
        return w, h

    # Layout vertical rows
    row_keys = ['top', 'middle', 'bottom']
    active_rows = [k for k in row_keys if rows[k]]
    if not active_rows:
        active_rows = ['middle']

    row_height = usable_h // max(len(active_rows), 1)

    for ri, rk in enumerate(active_rows):
        sects = rows[rk]
        if not sects: continue

        # Measure all sections in this row
        measurements = [(s, *measure_section(s)) for s in sects]
        total_natural_w = sum(m[1] for m in measurements) + gap * (len(sects) - 1)

        # Scale to fit if needed, but don't exceed natural width
        if total_natural_w > usable_w:
            scale = usable_w / total_natural_w
        else:
            scale = 1.0

        # Center the row
        actual_total_w = min(total_natural_w, usable_w)
        x_offset = margin + (usable_w - actual_total_w) // 2
        y_start = title_space + ri * row_height + (row_height - max(m[2] for m in measurements)) // 2

        x = x_offset
        for s, nat_w, nat_h in measurements:
            w = int(nat_w * scale)
            h = min(nat_h, row_height - 20)
            positions[s['id']] = (x, y_start, w, h)
            x += w + gap

    # Left/right columns
    for pos, align in [('left', 'left'), ('right', 'right')]:
        sects = rows[pos]
        if not sects: continue
        col_h = (usable_h - (len(sects) - 1) * gap) // max(len(sects), 1)
        for si, s in enumerate(sects):
            nat_w, nat_h = measure_section(s)
            w = min(nat_w, 380)
            h = min(nat_h, col_h)
            y = title_space + si * (col_h + gap)
            x = margin if align == 'left' else (WIDTH - margin - w)
            positions[s['id']] = (x, y, w, h)

    return positions

positions = compute_layout(SPEC.get('sections', []))

# --- Draw connections FIRST (behind boxes) then draw glow layer ---
conn_overlay = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
conn_draw = ImageDraw.Draw(conn_overlay)

for conn in SPEC.get('connections', []):
    fid, tid = conn.get('from'), conn.get('to')
    if fid not in positions or tid not in positions: continue
    fx, fy, fw, fh = positions[fid]
    tx, ty, tw, th = positions[tid]

    f_cx, f_cy = fx + fw // 2, fy + fh // 2
    t_cx, t_cy = tx + tw // 2, ty + th // 2

    if abs(f_cy - t_cy) > abs(f_cx - t_cx):
        start = (f_cx, fy + fh if t_cy > f_cy else fy)
        end = (t_cx, ty if t_cy > f_cy else ty + th)
    else:
        start = (fx + fw if t_cx > f_cx else fx, f_cy)
        end = (tx if t_cx > f_cx else tx + tw, t_cy)

    color = tuple(THEME['connectionColor'])
    style = conn.get('style', 'solid')

    # Draw thicker line with glow
    for width, alpha in [(8, 40), (4, 120), (2, 255)]:
        c = color[:3] + (alpha,) if len(color) == 3 else (*color[:3], alpha)
        if style == 'dashed':
            dx, dy = end[0] - start[0], end[1] - start[1]
            length = max((dx**2 + dy**2)**0.5, 1)
            segments = int(length / 16)
            for i in range(0, segments, 2):
                t1, t2 = i / segments, min((i + 1) / segments, 1.0)
                p1 = (int(start[0] + dx * t1), int(start[1] + dy * t1))
                p2 = (int(start[0] + dx * t2), int(start[1] + dy * t2))
                conn_draw.line([p1, p2], fill=c, width=width)
        else:
            conn_draw.line([start, end], fill=c, width=width)

    # Arrow head
    if style in ('arrow', 'solid'):
        dx, dy = end[0] - start[0], end[1] - start[1]
        angle = math.atan2(dy, dx)
        arrow_len = 18
        a1 = (int(end[0] - arrow_len * math.cos(angle - 0.35)),
              int(end[1] - arrow_len * math.sin(angle - 0.35)))
        a2 = (int(end[0] - arrow_len * math.cos(angle + 0.35)),
              int(end[1] - arrow_len * math.sin(angle + 0.35)))
        conn_draw.polygon([end, a1, a2], fill=color + (255,) if len(color) == 3 else color)

    # Connection label
    if conn.get('label'):
        mid = ((start[0] + end[0]) // 2, (start[1] + end[1]) // 2)
        bbox = conn_font.getbbox(conn['label'])
        lw, lh = bbox[2] - bbox[0] + 16, bbox[3] - bbox[1] + 10
        conn_draw.rounded_rectangle(
            [mid[0] - lw // 2, mid[1] - lh // 2, mid[0] + lw // 2, mid[1] + lh // 2],
            radius=6, fill=(0, 0, 0, 180))
        conn_draw.text(mid, conn['label'], fill=tuple(THEME['accentColor']),
                       font=conn_font, anchor='mm')

# Composite connections with glow
glow_color = THEME.get('glowColor')
if glow_color and glow_color != 'none':
    conn_glow = conn_overlay.filter(ImageFilter.GaussianBlur(radius=8))
    canvas = Image.alpha_composite(canvas, conn_glow)
canvas = Image.alpha_composite(canvas, conn_overlay)

# --- Draw sections on top of connections ---
for section in SPEC.get('sections', []):
    sid = section['id']
    if sid not in positions: continue
    x, y, w, h = positions[sid]

    # Section container with stronger background
    box_bg = tuple(THEME['boxBg'])
    # Make box background more opaque for readability
    if len(box_bg) == 4:
        box_bg = (box_bg[0], box_bg[1], box_bg[2], min(box_bg[3] + 60, 240))
    draw.rounded_rectangle([x, y, x + w, y + h], radius=14,
        fill=box_bg, outline=tuple(THEME['boxBorder']), width=2)

    # Section header bar — solid, high contrast
    header_h = 38
    header_bg = tuple(THEME['boxBorder'])[:3] + (180,)
    draw.rounded_rectangle([x, y, x + w, y + header_h], radius=14, fill=header_bg)
    draw.rectangle([x, y + 14, x + w, y + header_h], fill=header_bg)  # square off bottom corners
    draw.text((x + w // 2, y + header_h // 2), section.get('label', '').upper(),
              fill=(255, 255, 255, 255), font=section_font, anchor='mm')

    # Items
    iy = y + header_h + 10
    for item in section.get('items', []):
        if iy + 32 > y + h - 6: break
        # Item pill
        iw = text_width(str(item), item_font) + 24
        ix = x + (w - iw) // 2  # Center items
        draw.rounded_rectangle([ix, iy, ix + iw, iy + 28], radius=8,
            fill=tuple(THEME['boxBg']), outline=tuple(THEME['boxBorder']), width=1)
        draw.text((ix + iw // 2, iy + 14), str(item), fill=tuple(THEME['textColor']),
                  font=item_font, anchor='mm')
        iy += 36

# --- Title with shadow ---
title = SPEC.get('title', '')
# Shadow
draw.text((WIDTH // 2 + 2, 34), title, fill=(0, 0, 0, 150), font=title_font, anchor='mt')
# Main
draw.text((WIDTH // 2, 32), title, fill=tuple(THEME['titleColor']), font=title_font, anchor='mt')

# --- Subtitle ---
if SPEC.get('subtitle'):
    draw.text((WIDTH // 2, 88), SPEC['subtitle'], fill=tuple(THEME['textColor']),
              font=subtitle_font, anchor='mt')

# --- Tagline ---
if SPEC.get('tagline'):
    draw.text((WIDTH // 2 + 1, HEIGHT - 27), SPEC['tagline'],
              fill=(0, 0, 0, 120), font=tagline_font, anchor='mb')
    draw.text((WIDTH // 2, HEIGHT - 28), SPEC['tagline'],
              fill=tuple(THEME['accentColor']), font=tagline_font, anchor='mb')

# --- Glow on sections ---
if glow_color and glow_color != 'none':
    section_glow = overlay.filter(ImageFilter.GaussianBlur(radius=4))
    canvas = Image.alpha_composite(canvas, section_glow)

# --- Final composite ---
canvas = Image.alpha_composite(canvas, overlay)
canvas.convert('RGB').save(OUT_PATH, 'PNG', quality=95)
print(f'DIAGRAM_OK:{OUT_PATH}')
`;

// --- Helpers ---

async function generateBackground(
  config: ImageGenConfig,
  prompt: string,
  outPath: string,
): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${config.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, prompt }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) return { error: `Background generation failed: ${res.status} ${res.statusText}` };

    const text = await res.text();
    const lines = text.trim().split('\n');
    let imageBase64: string | null = null;
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.image) imageBase64 = d.image;
      } catch { /* skip non-JSON lines */ }
    }

    if (!imageBase64) return { error: 'Background generation returned no image data' };

    const buffer = Buffer.from(imageBase64, 'base64');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buffer);
    return {};
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { error: 'Background generation timed out (5 minute limit)' };
    }
    return { error: `Background generation failed: ${err instanceof Error ? err.message : err}` };
  }
}

function runPython(scriptPath: string, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('python3', [scriptPath], { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(toolExecutionError('diagram_generate', new Error(stderr || err.message)));
        return;
      }
      resolve(stdout + (stderr ? `\nSTDERR: ${stderr}` : ''));
    });
  });
}

// --- Tool factory ---

export function createDiagramGenerateTool(config: ImageGenConfig): LocalClawTool {
  return {
    name: 'diagram_generate',
    description: `Generate a styled architecture diagram with AI-generated background and composited elements.
WHEN TO USE: User asks for an architecture diagram, system diagram, infrastructure visualization, or tech stack diagram.
DO NOT use for: simple data charts (use code_session with matplotlib), or general images (use image_generate).

You provide a structured JSON layout spec with sections, connections, and a theme. Available themes: cyberpunk, corporate, blueprint, minimal, or a custom Flux prompt string.
Returns a [FILE:path] token for the generated diagram PNG.`,
    parameterDescription: 'spec (required): JSON string with: title, subtitle (optional), tagline (optional), theme ("cyberpunk"|"corporate"|"blueprint"|"minimal"|custom prompt), sections (array of {id, label, items[], position: "top"|"middle"|"bottom"|"left"|"right"}), connections (array of {from, to, label?, style?: "solid"|"dashed"|"arrow"}). filename (optional): Output filename without extension.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'JSON layout specification' },
        filename: { type: 'string', description: 'Output filename without extension' },
      },
      required: ['spec'],
    },
    example: 'diagram_generate[{"spec": "{\\"title\\": \\"My System\\", \\"theme\\": \\"cyberpunk\\", \\"sections\\": [{\\"id\\": \\"core\\", \\"label\\": \\"Core\\", \\"items\\": [\\"Router\\", \\"Specialist\\"], \\"position\\": \\"top\\"}], \\"connections\\": []}"}]',
    category: 'media',

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      // 1. Parse spec
      const rawSpec = params.spec;
      let spec: Record<string, unknown>;
      try {
        spec = typeof rawSpec === 'string' ? JSON.parse(rawSpec) : rawSpec as Record<string, unknown>;
      } catch {
        return 'Error: spec must be valid JSON. Provide a JSON string with title, theme, sections, and connections.';
      }

      if (!spec.title || !Array.isArray(spec.sections) || spec.sections.length === 0) {
        return 'Error: spec must include "title" (string) and "sections" (non-empty array).';
      }

      // 2. Resolve theme
      const themeName = (spec.theme as string) || 'cyberpunk';
      const knownTheme = THEMES[themeName];
      const themeConfig = knownTheme ?? { ...THEMES.cyberpunk, fluxPrompt: themeName };
      const fluxPrompt = knownTheme ? knownTheme.fluxPrompt : themeName;

      // 3. Set up paths
      const workspace = ctx.workspacePath ?? 'data/workspaces/main';
      const outDir = join(workspace, 'diagrams');
      mkdirSync(outDir, { recursive: true });

      const filename = (params.filename as string) || `diagram_${Date.now()}`;
      const bgPath = join(outDir, `_bg_${randomUUID().slice(0, 8)}.png`);
      const outPath = join(outDir, `${filename}.png`);

      // 4. Generate background via Flux
      console.log(`[Diagram] Generating ${themeName} background via Flux...`);
      const bgResult = await generateBackground(config, fluxPrompt, bgPath);
      if (bgResult.error) return bgResult.error;

      // 5. Write spec + theme as JSON files (avoids all escaping issues in Python template)
      const uid = randomUUID().slice(0, 8);
      const specPath = join(outDir, `_spec_${uid}.json`);
      const themePath = join(outDir, `_theme_${uid}.json`);
      writeFileSync(specPath, JSON.stringify(spec));
      writeFileSync(themePath, JSON.stringify(themeConfig));

      const script = PYTHON_TEMPLATE
        .replace('__SPEC_PATH__', specPath)
        .replace('__THEME_PATH__', themePath)
        .replace('__BACKGROUND_PATH__', bgPath)
        .replace('__OUTPUT_PATH__', outPath);

      // 6. Write temp script and execute
      const tmpScript = join(outDir, `_tmp_${uid}.py`);
      writeFileSync(tmpScript, script);

      console.log(`[Diagram] Compositing with Pillow...`);
      try {
        const result = await runPython(tmpScript);
        if (!result.includes('DIAGRAM_OK:')) {
          return `Diagram rendering failed: ${result.slice(0, 500)}`;
        }
      } catch (err) {
        return `Diagram rendering failed: ${err instanceof Error ? err.message : err}`;
      } finally {
        try { unlinkSync(tmpScript); } catch { /* ignore */ }
        try { unlinkSync(specPath); } catch { /* ignore */ }
        try { unlinkSync(themePath); } catch { /* ignore */ }
        try { unlinkSync(bgPath); } catch { /* ignore */ }
      }

      const size = Math.round(statSync(outPath).size / 1024);
      console.log(`[Diagram] Generated: ${outPath} (${size}KB)`);
      return `Diagram generated: ${outPath} (${size}KB)\n[FILE:${outPath}]`;
    },
  };
}
