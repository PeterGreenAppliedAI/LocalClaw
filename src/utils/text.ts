/**
 * Text utility functions extracted from orchestrator.
 * Pure functions with no external dependencies.
 */

/** Strip thinking blocks from text (Qwen <think> and Gemma 4 <|channel>thought formats). */
export function stripThinkingTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\S]{0,500}?<\/think>/g, '')
    .replace(/<\/?think>/g, '')
    .replace(/<\|channel>thought\n[\s\S]*?<channel\|>/g, '')
    .replace(/<\|channel>thought[\s\S]*$/g, '')
    .trim();
}

/** Split text into chunks respecting line/word boundaries. */
export function splitFinalMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt === -1 || splitAt < limit / 2) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt === -1 || splitAt < limit / 2) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
