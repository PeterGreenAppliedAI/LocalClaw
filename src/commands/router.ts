/**
 * Command router — detects !-prefixed commands and routes to handlers.
 * Extracted from orchestrator to reduce its responsibility surface.
 *
 * Currently a thin routing layer. Handler implementations will be
 * progressively extracted from the orchestrator into this module.
 */

/** Check if a message is a command (!reset, !save, etc.) or a pending response (1, 2) */
export function isCommand(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  if (trimmed.startsWith('!')) return true;
  // Pending file choice responses
  if (trimmed === '1' || trimmed === '2') return true;
  return false;
}

/** Get the command name from a message */
export function getCommandName(content: string): string {
  const trimmed = content.trim().toLowerCase();
  if (trimmed === '1' || trimmed === '2') return 'file_choice';
  if (trimmed === '!new' || trimmed === '!reset') return 'reset';
  if (trimmed === '!save') return 'save';
  if (trimmed === '!discard') return 'discard';
  if (trimmed === '!cleanup') return 'cleanup';
  if (trimmed === '!promote') return 'promote';
  if (trimmed.startsWith('!heartbeat')) return 'heartbeat';
  if (trimmed.startsWith('!forget')) return 'forget';
  if (trimmed.startsWith('!research')) return 'research';
  return 'unknown';
}

/** All recognized command names */
export const COMMAND_NAMES = [
  'reset', 'save', 'discard', 'file_choice', 'cleanup',
  'heartbeat', 'promote', 'forget', 'research',
] as const;

export type CommandName = typeof COMMAND_NAMES[number];
