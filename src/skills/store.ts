/**
 * Skill store — persistent procedural memory for the plan pipeline.
 * Skills are saved execution patterns that can be reused for similar tasks.
 *
 * Adapted from Hermes Agent's skill system with progressive disclosure.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Skill {
  name: string;
  slug: string;
  description: string;
  created: string;
  lastUsed: string;
  successCount: number;
  steps: SkillStep[];
  notes: string[];
}

export interface SkillStep {
  tool: string;
  params: Record<string, unknown>;
  purpose: string;
}

/**
 * Parse a skill from its markdown file.
 * Format: YAML-ish frontmatter + ## Steps + ## Learned sections.
 */
function parseSkill(content: string, slug: string): Skill | null {
  // Parse frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm: Record<string, string> = {};
  for (const line of fmMatch[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length > 0) {
      fm[key.trim()] = rest.join(':').trim();
    }
  }

  // Parse steps
  const steps: SkillStep[] = [];
  const stepsMatch = content.match(/## Steps\n([\s\S]*?)(?=\n## |\n*$)/);
  if (stepsMatch) {
    const stepLines = stepsMatch[1].split('\n').filter(l => l.match(/^\d+\./));
    for (const line of stepLines) {
      // "1. browser open https://eventbrite.com — Navigate to site"
      const parsed = line.replace(/^\d+\.\s*/, '').trim();
      const toolMatch = parsed.match(/^(\S+)\s+(.+?)(?:\s+—\s+(.+))?$/);
      if (toolMatch) {
        const tool = toolMatch[1];
        const paramsRaw = toolMatch[2];
        const purpose = toolMatch[3] ?? '';

        // Try to parse params as JSON, otherwise treat as a simple action string
        let params: Record<string, unknown>;
        try {
          params = JSON.parse(paramsRaw);
        } catch {
          params = { action: paramsRaw };
        }

        steps.push({ tool, params, purpose });
      }
    }
  }

  // Parse notes
  const notes: string[] = [];
  const notesMatch = content.match(/## (?:Learned|Notes)\n([\s\S]*?)(?=\n## |\n*$)/);
  if (notesMatch) {
    for (const line of notesMatch[1].split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-')) {
        notes.push(trimmed.slice(1).trim());
      }
    }
  }

  return {
    name: fm.name ?? slug,
    slug,
    description: fm.description ?? '',
    created: fm.created ?? new Date().toISOString().split('T')[0],
    lastUsed: fm.last_used ?? fm.created ?? '',
    successCount: parseInt(fm.success_count ?? '0', 10),
    steps,
    notes,
  };
}

/**
 * Serialize a skill to markdown format.
 */
function serializeSkill(skill: Skill): string {
  const lines: string[] = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `created: ${skill.created}`,
    `last_used: ${skill.lastUsed}`,
    `success_count: ${skill.successCount}`,
    '---',
    '',
    '## Steps',
  ];

  for (let i = 0; i < skill.steps.length; i++) {
    const s = skill.steps[i];
    const paramsStr = JSON.stringify(s.params);
    const purpose = s.purpose ? ` — ${s.purpose}` : '';
    lines.push(`${i + 1}. ${s.tool} ${paramsStr}${purpose}`);
  }

  if (skill.notes.length > 0) {
    lines.push('');
    lines.push('## Learned');
    for (const note of skill.notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export class SkillStore {
  private readonly skillsDir: string;

  constructor(workspacePath: string) {
    this.skillsDir = join(workspacePath, 'skills');
    mkdirSync(this.skillsDir, { recursive: true });
  }

  /** List all skills (name + description only — progressive disclosure tier 1). */
  list(): Array<{ slug: string; name: string; description: string; successCount: number }> {
    if (!existsSync(this.skillsDir)) return [];

    const files = readdirSync(this.skillsDir).filter(f => f.endsWith('.md'));
    const result: Array<{ slug: string; name: string; description: string; successCount: number }> = [];

    for (const file of files) {
      try {
        const content = readFileSync(join(this.skillsDir, file), 'utf-8');
        const slug = file.replace(/\.md$/, '');
        const skill = parseSkill(content, slug);
        if (skill) {
          result.push({
            slug: skill.slug,
            name: skill.name,
            description: skill.description,
            successCount: skill.successCount,
          });
        }
      } catch { /* skip malformed */ }
    }

    return result;
  }

  /** Load a full skill (progressive disclosure tier 2). */
  get(slug: string): Skill | null {
    const path = join(this.skillsDir, `${slug}.md`);
    if (!existsSync(path)) return null;

    try {
      const content = readFileSync(path, 'utf-8');
      return parseSkill(content, slug);
    } catch {
      return null;
    }
  }

  /** Save a new skill or overwrite an existing one. */
  save(skill: Skill): void {
    const path = join(this.skillsDir, `${skill.slug}.md`);
    writeFileSync(path, serializeSkill(skill));
    console.log(`[Skills] Saved skill: "${skill.name}" (${skill.slug})`);
  }

  /** Record a successful use — increment count and update last_used. */
  recordSuccess(slug: string): void {
    const skill = this.get(slug);
    if (!skill) return;

    skill.successCount++;
    skill.lastUsed = new Date().toISOString().split('T')[0];
    this.save(skill);
  }

  /** Add a learned note to an existing skill. */
  addNote(slug: string, note: string): void {
    const skill = this.get(slug);
    if (!skill) return;

    if (!skill.notes.includes(note)) {
      skill.notes.push(note);
      this.save(skill);
      console.log(`[Skills] Added note to "${skill.name}": ${note}`);
    }
  }
}
