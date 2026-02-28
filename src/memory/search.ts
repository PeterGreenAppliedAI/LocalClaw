import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * System files that should never appear in memory search results.
 * These are workspace configuration files, not user memories.
 * MEMORY.md is intentionally excluded from this set — it IS user memory.
 */
const SYSTEM_FILES = new Set([
  'SOUL.md',
  'AGENTS.md',
  'IDENTITY.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'USER.md',
  'TASKS.md',
]);

export interface MemorySearchResult {
  file: string;
  section: string;
  score: number;
  content: string;
}

/**
 * Keyword-based search over markdown files in a workspace directory.
 * Splits files into sections (by ## headers), scores by keyword density.
 */
export function searchMarkdownFiles(
  workspacePath: string,
  query: string,
  maxResults = 5,
  onlyFiles?: string[],
): MemorySearchResult[] {
  if (!existsSync(workspacePath)) return [];

  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);

  if (keywords.length === 0) return [];

  const mdFiles = onlyFiles ?? findMarkdownFiles(workspacePath);
  const results: MemorySearchResult[] = [];

  for (const filePath of mdFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const sections = splitIntoSections(content);
    const relPath = relative(workspacePath, filePath);

    for (const section of sections) {
      const score = scoreSection(section.content, keywords);
      if (score > 0) {
        results.push({
          file: relPath,
          section: section.heading,
          score,
          content: section.content.slice(0, 500),
        });
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(current: string) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'memory') continue;
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.md') && !SYSTEM_FILES.has(entry)) {
          files.push(full);
        }
      } catch {
        continue;
      }
    }
  }

  walk(dir);
  return files;
}

interface Section {
  heading: string;
  content: string;
}

function splitIntoSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let currentHeading = '(top)';
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      if (currentContent.length > 0) {
        sections.push({ heading: currentHeading, content: currentContent.join('\n') });
      }
      currentHeading = headingMatch[1];
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0) {
    sections.push({ heading: currentHeading, content: currentContent.join('\n') });
  }

  return sections;
}

function scoreSection(content: string, keywords: string[]): number {
  const lower = content.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    const matches = lower.split(keyword).length - 1;
    score += matches;
  }
  return score;
}
