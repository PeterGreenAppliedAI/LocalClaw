import type { LocalClawConfig, AgentBinding } from '../config/types.js';

export interface RouteInput {
  channel: string;
  senderId: string;
  guildId?: string;
  channelId?: string;
}

export interface ResolvedRoute {
  agentId: string;
  sessionKey: string;
  matchedBy: 'binding.peer' | 'binding.guild' | 'binding.channel' | 'default';
}

/**
 * Resolve which agent should handle a message based on binding rules.
 * Precedence: peer → guild → channel → default
 */
export function resolveRoute(input: RouteInput, config: LocalClawConfig): ResolvedRoute {
  const bindings = config.agents.bindings;
  const defaultAgentId = config.agents.default;

  // 1. Check peer-level bindings (direct user match)
  for (const binding of bindings) {
    if (binding.match?.peerId === input.senderId) {
      return {
        agentId: binding.agentId,
        sessionKey: buildSessionKey(binding.agentId, input),
        matchedBy: 'binding.peer',
      };
    }
  }

  // 2. Check guild-level bindings
  if (input.guildId) {
    for (const binding of bindings) {
      if (binding.match?.guildId === input.guildId) {
        const channelMatch = !binding.match?.channel || binding.match.channel === input.channel;
        if (channelMatch) {
          return {
            agentId: binding.agentId,
            sessionKey: buildSessionKey(binding.agentId, input),
            matchedBy: 'binding.guild',
          };
        }
      }
    }
  }

  // 3. Check channel-level bindings
  for (const binding of bindings) {
    if (binding.match?.channel === input.channel && !binding.match?.guildId && !binding.match?.peerId) {
      return {
        agentId: binding.agentId,
        sessionKey: buildSessionKey(binding.agentId, input),
        matchedBy: 'binding.channel',
      };
    }
  }

  // 4. Default
  return {
    agentId: defaultAgentId,
    sessionKey: buildSessionKey(defaultAgentId, input),
    matchedBy: 'default',
  };
}

function buildSessionKey(agentId: string, input: RouteInput): string {
  const parts = [agentId, input.channel];
  if (input.guildId) parts.push(input.guildId);
  if (input.channelId) parts.push(input.channelId);
  parts.push(input.senderId);
  return parts.join(':');
}
