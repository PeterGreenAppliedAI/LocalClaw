/**
 * Skill matcher — finds the best matching skill for a given goal.
 * Uses keyword overlap scoring against skill names and descriptions.
 */

import type { SkillStore } from './store.js';

interface SkillMatch {
  slug: string;
  name: string;
  score: number;
}

/**
 * Find the best matching skill for a user's goal.
 * Returns the match with score > threshold, or null if nothing relevant.
 *
 * Scoring:
 * - Each keyword match in name: +3
 * - Each keyword match in description: +2
 * - Bonus for high success count: +1 per 5 successes (max +2)
 * - Minimum score threshold: 8 (prevents weak/generic matches)
 * - At least 30% of goal keywords must match (prevents 2-of-20 false positives)
 */
export function findMatchingSkill(
  store: SkillStore,
  goal: string,
  threshold = 8,
): SkillMatch | null {
  const skills = store.list();
  if (skills.length === 0) return null;

  // Extract keywords from goal (drop stop words, lowercase)
  const stopWords = new Set([
    'a', 'an', 'the', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'of',
    'is', 'it', 'my', 'me', 'i', 'do', 'go', 'then', 'from', 'with',
    'this', 'that', 'can', 'you', 'please', 'find', 'get', 'add', 'one',
    'first', 'next', 'near', 'them', 'their', 'some', 'using',
    'make', 'create', 'search', 'report', 'today', 'current', 'latest',
  ]);

  const keywords = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return null;

  let best: SkillMatch | null = null;

  for (const skill of skills) {
    const nameLower = skill.name.toLowerCase();
    const descLower = skill.description.toLowerCase();
    let score = 0;
    let matchedKeywords = 0;

    for (const kw of keywords) {
      const matched = nameLower.includes(kw) || descLower.includes(kw);
      if (matched) matchedKeywords++;
      if (nameLower.includes(kw)) score += 3;
      if (descLower.includes(kw)) score += 2;
    }

    // Require at least 30% of goal keywords to match
    if (keywords.length > 3 && matchedKeywords / keywords.length < 0.3) continue;

    // Bonus for proven skills (capped lower to prevent inflated counts from dominating)
    score += Math.min(2, Math.floor(skill.successCount / 5));

    if (score >= threshold && (!best || score > best.score)) {
      best = { slug: skill.slug, name: skill.name, score };
    }
  }

  if (best) {
    console.log(`[Skills] Matched "${best.name}" (score: ${best.score}) for goal: "${goal.slice(0, 60)}..."`);
  }

  return best;
}
