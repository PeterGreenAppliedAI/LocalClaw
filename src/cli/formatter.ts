/**
 * Terminal formatting utilities — colors, markdown rendering, status display.
 * No dependencies — uses ANSI escape codes directly.
 */

// ANSI color codes
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Background
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
} as const;

export function bold(text: string): string { return `${C.bold}${text}${C.reset}`; }
export function dim(text: string): string { return `${C.dim}${text}${C.reset}`; }
export function red(text: string): string { return `${C.red}${text}${C.reset}`; }
export function green(text: string): string { return `${C.green}${text}${C.reset}`; }
export function yellow(text: string): string { return `${C.yellow}${text}${C.reset}`; }
export function blue(text: string): string { return `${C.blue}${text}${C.reset}`; }
export function cyan(text: string): string { return `${C.cyan}${text}${C.reset}`; }
export function magenta(text: string): string { return `${C.magenta}${text}${C.reset}`; }
export function gray(text: string): string { return `${C.gray}${text}${C.reset}`; }

/**
 * Render markdown-ish text for the terminal.
 * Handles: headers, bold, italic, code blocks, inline code, bullet lists, links.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) {
        const lang = line.trim().slice(3);
        result.push(dim(`─── ${lang || 'code'} ───`));
      } else {
        result.push(dim('───────────'));
      }
      continue;
    }

    if (inCodeBlock) {
      result.push(`  ${C.cyan}${line}${C.reset}`);
      continue;
    }

    let processed = line;

    // Headers
    if (processed.startsWith('#### ')) {
      result.push(`${C.bold}${C.blue}${processed.slice(5)}${C.reset}`);
      continue;
    }
    if (processed.startsWith('### ')) {
      result.push(`${C.bold}${C.blue}${processed.slice(4)}${C.reset}`);
      continue;
    }
    if (processed.startsWith('## ')) {
      result.push(`\n${C.bold}${C.cyan}${processed.slice(3)}${C.reset}`);
      continue;
    }
    if (processed.startsWith('# ')) {
      result.push(`\n${C.bold}${C.magenta}${processed.slice(2)}${C.reset}`);
      continue;
    }

    // Inline code
    processed = processed.replace(/`([^`]+)`/g, `${C.cyan}$1${C.reset}`);

    // Bold
    processed = processed.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.reset}`);

    // Italic
    processed = processed.replace(/\*([^*]+)\*/g, `${C.italic}$1${C.reset}`);

    // Links [text](url) → text (url)
    processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${C.underline}$1${C.reset} ${C.dim}($2)${C.reset}`);

    // Bullet points
    if (processed.match(/^\s*[-*]\s/)) {
      processed = processed.replace(/^(\s*)[-*]\s/, `$1${C.green}•${C.reset} `);
    }

    result.push(processed);
  }

  return result.join('\n');
}

/**
 * Format a status bar showing current model, category, and session info.
 */
export function formatStatusBar(info: {
  model: string;
  category?: string;
  confidence?: string;
  iterations?: number;
  sessionKey?: string;
}): string {
  const parts: string[] = [];
  if (info.category) {
    const conf = info.confidence ?? '';
    parts.push(`${C.bold}${info.category}${C.reset}${conf ? ` ${C.dim}(${conf})${C.reset}` : ''}`);
  }
  if (info.iterations !== undefined) {
    parts.push(`${C.dim}${info.iterations} step${info.iterations !== 1 ? 's' : ''}${C.reset}`);
  }
  parts.push(`${C.dim}model:${C.reset}${info.model}`);

  return `  ${C.gray}[${C.reset}${parts.join(` ${C.gray}|${C.reset} `)}${C.gray}]${C.reset}`;
}

/**
 * Format tool call for display.
 */
export function formatToolCall(tool: string, params?: Record<string, unknown>): string {
  const paramStr = params ? ` ${C.dim}${JSON.stringify(params).slice(0, 80)}${C.reset}` : '';
  return `  ${C.yellow}⚡${C.reset} ${C.bold}${tool}${C.reset}${paramStr}`;
}

/**
 * Format an error message.
 */
export function formatError(msg: string): string {
  return `${C.red}✗${C.reset} ${msg}`;
}

/**
 * Format a success message.
 */
export function formatSuccess(msg: string): string {
  return `${C.green}✓${C.reset} ${msg}`;
}

/**
 * Print a section divider.
 */
export function divider(label?: string): string {
  const width = Math.min(process.stdout.columns || 80, 80);
  if (label) {
    const padding = Math.max(0, width - label.length - 4);
    return `${C.dim}── ${C.reset}${label}${C.dim} ${'─'.repeat(padding)}${C.reset}`;
  }
  return `${C.dim}${'─'.repeat(width)}${C.reset}`;
}
