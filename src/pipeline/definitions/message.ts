import type { PipelineDefinition } from '../types.js';

/**
 * Message pipeline: extract(channel, channelId, text) → tool(send_message) → code(confirm)
 *
 * Replaces the ReAct loop for the "message" category.
 * The LLM only extracts parameters — the workflow is deterministic.
 */
export const messagePipeline: PipelineDefinition = {
  name: 'message',
  stages: [
    {
      name: 'extract_params',
      type: 'extract',
      schema: {
        channel: {
          type: 'string',
          description: 'Channel adapter ID to send the message through',
          required: true,
          enum: ['discord', 'telegram', 'slack', 'whatsapp'],
        },
        channelId: {
          type: 'string',
          description: 'Target channel or chat ID (e.g., Discord channel ID, Telegram chat ID)',
          required: true,
        },
        text: {
          type: 'string',
          description: 'The message text to send',
          required: true,
        },
      },
      examples: [
        {
          input: 'send a message to #general saying hello everyone',
          output: { channel: 'discord', channelId: 'general', text: 'hello everyone' },
        },
        {
          input: 'tell the telegram group that the meeting is at 3pm',
          output: { channel: 'telegram', channelId: '', text: 'The meeting is at 3pm' },
        },
      ],
    },
    {
      name: 'use_source_defaults',
      type: 'code',
      execute: (ctx) => {
        // If the user didn't specify a channel, use the source channel
        if (!ctx.params.channel && ctx.sourceContext?.channel) {
          ctx.params.channel = ctx.sourceContext.channel;
        }
        if (!ctx.params.channelId && ctx.sourceContext?.channelId) {
          ctx.params.channelId = ctx.sourceContext.channelId;
        }
        return ctx.params;
      },
    },
    {
      name: 'send',
      type: 'tool',
      tool: 'send_message',
      resolveParams: (ctx) => ({
        channel: ctx.params.channel,
        channelId: ctx.params.channelId,
        text: ctx.params.text,
      }),
    },
    {
      name: 'confirm',
      type: 'code',
      execute: (ctx) => {
        const result = ctx.stageResults.send as string;
        ctx.answer = result.startsWith('Message sent')
          ? `Done — message sent to ${ctx.params.channel}:${ctx.params.channelId}.`
          : `Failed to send message: ${result}`;
        return ctx.answer;
      },
    },
  ],
};
