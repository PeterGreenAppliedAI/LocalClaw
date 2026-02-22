import type { LocalClawTool } from './types.js';
import type { WebsiteConfig } from '../config/types.js';

export function createWebsiteQueryTool(config?: WebsiteConfig): LocalClawTool {
  return {
    name: 'website_query',
    description: 'Query a teaching website API for courses, assignments, homework, materials, and student information. Supports GET and POST requests.',
    parameterDescription: 'endpoint (required): API endpoint path (e.g., "/courses", "/assignments", "/students"). method (optional): HTTP method, default "GET". body (optional): JSON string for POST body. query (optional): Query parameters as JSON string.',
    parameters: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: 'API endpoint path (e.g., "/courses", "/assignments")' },
        method: { type: 'string', description: 'HTTP method (GET or POST)', enum: ['GET', 'POST'] },
        body: { type: 'string', description: 'JSON string for POST request body' },
        query: { type: 'string', description: 'Query parameters as JSON string of key-value pairs' },
      },
      required: ['endpoint'],
    },
    category: 'website',

    async execute(params: Record<string, unknown>): Promise<string> {
      const baseUrl = config?.baseUrl;
      const apiKey = config?.apiKey ?? process.env.WEBSITE_API_KEY;

      if (!baseUrl) {
        return 'Error: Website base URL not configured. Set tools.website.baseUrl in localclaw.config.json5.';
      }

      const endpoint = params.endpoint as string;
      if (!endpoint) return 'Error: endpoint parameter is required';

      const method = (params.method as string) ?? 'GET';

      // Build URL with query params
      const url = new URL(endpoint, baseUrl);
      if (params.query) {
        try {
          const queryParams = typeof params.query === 'string' ? JSON.parse(params.query) : params.query;
          for (const [k, v] of Object.entries(queryParams as Record<string, string>)) {
            url.searchParams.set(k, String(v));
          }
        } catch {
          return 'Error: Invalid query parameters. Must be a JSON object.';
        }
      }

      try {
        const headers: Record<string, string> = {
          'Accept': 'application/json',
        };
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: AbortSignal.timeout(15_000),
        };

        if (method === 'POST' && params.body) {
          headers['Content-Type'] = 'application/json';
          fetchOptions.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
        }

        const res = await fetch(url.toString(), fetchOptions);

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          return `Error: API returned ${res.status} ${res.statusText}${errBody ? `: ${errBody.slice(0, 500)}` : ''}`;
        }

        const contentType = res.headers.get('content-type') ?? '';
        if (contentType.includes('json')) {
          const data = await res.json();
          return JSON.stringify(data, null, 2).slice(0, 5000);
        }

        const text = await res.text();
        return text.slice(0, 5000);
      } catch (err) {
        return `Error querying website: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}
