import type { LocalClawTool, ToolContext } from './types.js';
import type { WebFetchConfig } from '../config/types.js';
import { assertPublicUrl, assertPublicRedirect } from './ssrf.js';
import { LocalClawError } from '../errors.js';
import { extractReadableContent, htmlToMarkdown, truncateText } from './web-fetch-utils.js';

export function createWebFetchTool(config?: WebFetchConfig): LocalClawTool {
  const maxChars = config?.maxChars ?? 30000;

  return {
    name: 'web_fetch',
    description: 'Fetch the content of a URL and extract readable text',
    parameterDescription: 'url (required): The URL to fetch. extractMode (optional): "markdown" or "text" (default: "text"). maxChars (optional): max characters to return.',
    example: 'web_fetch[{"url": "https://arxiv.org/abs/2401.12345", "extractMode": "markdown"}]',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        extractMode: { type: 'string', description: 'Extract mode', enum: ['markdown', 'text'] },
        maxChars: { type: 'string', description: 'Maximum characters to return' },
      },
      required: ['url'],
    },
    category: 'web_search',

    async execute(params: Record<string, unknown>): Promise<string> {
      const url = params.url as string;
      if (!url) return 'Error: url parameter is required';

      // SSRF protection
      await assertPublicUrl(url);

      const extractMode = (params.extractMode as string) ?? 'text';
      const limit = (params.maxChars as number) ?? maxChars;

      try {
        // Use http.Agent or undici dispatcher to handle TLS if needed
        // Manual redirect handling — re-check SSRF on each hop
        const fetchOptions: RequestInit = {
          headers: {
            'User-Agent': 'LocalClaw/1.0 (Web Fetcher)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(30_000),
          redirect: 'manual',
        };

        let currentUrl = url;
        let res = await fetch(currentUrl, fetchOptions);
        let hops = 0;
        const MAX_REDIRECTS = 5;

        while (res.status >= 300 && res.status < 400 && hops < MAX_REDIRECTS) {
          const location = res.headers.get('location');
          if (!location) break;
          await assertPublicRedirect(currentUrl, location);
          currentUrl = new URL(location, currentUrl).toString();
          res = await fetch(currentUrl, fetchOptions);
          hops++;
        }

        if (!res.ok) {
          return `Error: HTTP ${res.status} ${res.statusText}`;
        }

        const contentType = res.headers.get('content-type') ?? '';
        const body = await res.text();

        // Non-HTML: return raw (truncated)
        if (!contentType.includes('html')) {
          return truncateText(body, limit);
        }

        // HTML: extract with Readability
        try {
          const article = await extractReadableContent(body, url);

          if (extractMode === 'markdown') {
            const md = htmlToMarkdown(article.content);
            return truncateText(`# ${article.title}\n\n${md}`, limit);
          }

          return truncateText(`${article.title}\n\n${article.textContent}`, limit);
        } catch {
          // Readability failed — return raw HTML → markdown
          const md = htmlToMarkdown(body);
          return truncateText(md, limit);
        }
      } catch (err) {
        // Never bypass SSRF blocks via fallback
        if (err instanceof LocalClawError && err.code === 'SSRF_BLOCKED') {
          return `Error: ${err.message}`;
        }
        // Firecrawl fallback for non-security errors
        if (config?.firecrawlApiKey) {
          return fetchViaFirecrawl(url, config.firecrawlApiKey, config.firecrawlBaseUrl, limit);
        }
        return `Error fetching ${url}: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

async function fetchViaFirecrawl(
  url: string,
  apiKey: string,
  baseUrl?: string,
  maxChars = 30000,
): Promise<string> {
  const endpoint = `${baseUrl ?? 'https://api.firecrawl.dev'}/v1/scrape`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      return `Error: Firecrawl returned ${res.status}`;
    }

    const data = await res.json() as { data?: { markdown?: string } };
    const md = data?.data?.markdown ?? '';
    return truncateText(md, maxChars);
  } catch (err) {
    return `Error: Firecrawl failed: ${err instanceof Error ? err.message : err}`;
  }
}
