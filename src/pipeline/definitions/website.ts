import type { PipelineDefinition } from '../types.js';

/**
 * Website pipeline: extract(endpoint, method, query, body) → tool(website_query) → llm(format)
 *
 * Replaces the ReAct loop for the "website" category.
 * The LLM extracts API parameters, then formats the raw JSON response.
 */
export const websitePipeline: PipelineDefinition = {
  name: 'website',
  stages: [
    {
      name: 'extract_params',
      type: 'extract',
      schema: {
        endpoint: {
          type: 'string',
          description: 'API endpoint path (e.g., "/courses", "/assignments", "/users")',
          required: true,
        },
        method: {
          type: 'string',
          description: 'HTTP method',
          enum: ['GET', 'POST'],
        },
        query: {
          type: 'string',
          description: 'Query parameters as JSON string of key-value pairs (e.g., \'{"status":"active"}\')',
        },
        body: {
          type: 'string',
          description: 'Request body as JSON string (for POST requests)',
        },
      },
      examples: [
        {
          input: 'show me all courses',
          output: { endpoint: '/courses', method: 'GET' },
        },
        {
          input: 'get active assignments',
          output: { endpoint: '/assignments', method: 'GET', query: '{"status":"active"}' },
        },
      ],
    },
    {
      name: 'query',
      type: 'tool',
      tool: 'website_query',
      resolveParams: (ctx) => {
        const params: Record<string, unknown> = {
          endpoint: ctx.params.endpoint,
        };
        if (ctx.params.method) params.method = ctx.params.method;
        if (ctx.params.query) params.query = ctx.params.query;
        if (ctx.params.body) params.body = ctx.params.body;
        return params;
      },
    },
    {
      name: 'format',
      type: 'llm',
      stream: true,
      temperature: 0.3,
      maxTokens: 2048,
      buildPrompt: (ctx) => {
        const rawResult = ctx.stageResults.query as string;
        return {
          system: 'You are a helpful assistant. Format the API response data into a clear, readable answer for the user. Be concise. If the data is empty, say so.',
          user: `User asked: "${ctx.userMessage}"\n\nAPI response:\n${rawResult}`,
        };
      },
    },
  ],
};
