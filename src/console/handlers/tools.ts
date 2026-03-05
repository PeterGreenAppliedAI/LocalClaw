import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConsoleApiDeps } from '../types.js';
import { sendJson } from '../helpers/send-json.js';

export function handleTools(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): void {
  const names = deps.toolRegistry.list();
  const tools = names.map(name => {
    const tool = deps.toolRegistry.get(name);
    return tool ? {
      name: tool.name,
      description: tool.description,
      parameterDescription: tool.parameterDescription,
      category: tool.category,
      hasParameters: !!tool.parameters,
    } : { name };
  });
  sendJson(res, tools);
}
