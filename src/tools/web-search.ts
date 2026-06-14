import type { LocalClawTool } from './types.js';
import type { WebSearchConfig } from '../config/types.js';
import { readCache, writeCache, normalizeCacheKey, type CacheEntry } from './web-shared.js';

type SearchResult = { title: string; url: string; snippet: string };

const searchCache = new Map<string, CacheEntry<SearchResult[]>>();

export function createWebSearchTool(config?: WebSearchConfig): LocalClawTool {
  const provider = config?.provider ?? 'brave';
  const cacheTtl = config?.cacheTtlMs ?? 15 * 60 * 1000;
  const baseUrl = config?.baseUrl;

  return {
    name: 'web_search',
    description: 'Search the web for current information',
    parameterDescription: 'query (required): Search query. count (optional): Number of results (default 5). freshness (optional): "day", "week", "month".',
    example: 'web_search[{"query": "NVIDIA earnings Q1 2026", "count": 5}]',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        count: { type: 'number', description: 'Number of results to return (default 5)' },
        freshness: { type: 'string', description: 'Time filter', enum: ['day', 'week', 'month', 'year'] },
      },
      required: ['query'],
    },
    category: 'web_search',

    async execute(params: Record<string, unknown>): Promise<string> {
      const query = params.query as string;
      if (!query) return 'Error: query parameter is required';

      const count = (params.count as number) ?? 5;
      const freshness = params.freshness as string | undefined;

      // Cache check
      // Case-insensitive on the query (readCache no longer normalizes internally)
      const cacheKey = `${provider}:${normalizeCacheKey(query)}:${count}:${freshness ?? ''}`;
      const cached = readCache(searchCache, cacheKey);
      if (cached) return formatResults(cached, query);

      // searxng is self-hosted — no API key, just a base URL.
      if (provider === 'searxng' && !baseUrl) {
        return 'Error: searxng provider requires a baseUrl (e.g. "http://host:8080") in web search config.';
      }
      const apiKey = resolveApiKey(provider, config);
      if (!apiKey && provider !== 'searxng') {
        return `Error: No API key configured for ${provider}. Set the appropriate env var.`;
      }

      let results: SearchResult[];
      try {
        switch (provider) {
          case 'brave':
            results = await searchBrave(query, count, freshness, apiKey!);
            break;
          case 'perplexity':
            results = await searchPerplexity(query, count, apiKey!);
            break;
          case 'grok':
            results = await searchGrok(query, count, apiKey!);
            break;
          case 'tavily':
            results = await searchTavily(query, count, apiKey!);
            break;
          case 'searxng':
            results = await searchSearxng(query, count, freshness, baseUrl!);
            break;
          default:
            return `Error: Unknown search provider "${provider}"`;
        }
      } catch (err) {
        return `Search error: ${err instanceof Error ? err.message : err}`;
      }

      writeCache(searchCache, cacheKey, results, cacheTtl);
      return formatResults(results, query);
    },
  };
}

function resolveApiKey(provider: string, config?: WebSearchConfig): string | undefined {
  if (config?.apiKey) return config.apiKey;
  switch (provider) {
    case 'brave': return process.env.BRAVE_API_KEY;
    case 'perplexity': return process.env.PERPLEXITY_API_KEY;
    case 'grok': return process.env.GROK_API_KEY;
    case 'tavily': return process.env.TAVILY_API_KEY;
    default: return undefined;
  }
}

function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) return `No results found for "${query}"`;

  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join('\n\n');
}

// --- Provider implementations ---

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Brave's free tier allows ~1 request/second. The research pipeline fans out
// several facets at once, so without spacing every concurrent call 429s. Serialize
// Brave requests through a single promise chain with a minimum interval; concurrent
// callers queue instead of bursting.
const BRAVE_MIN_INTERVAL_MS = 1100;
let braveChain: Promise<void> = Promise.resolve();
let braveLastAt = 0;

function braveThrottle(): Promise<void> {
  const run = braveChain.then(async () => {
    const wait = BRAVE_MIN_INTERVAL_MS - (Date.now() - braveLastAt);
    if (wait > 0) await sleep(wait);
    braveLastAt = Date.now();
  });
  braveChain = run.catch(() => {});
  return run;
}

async function searchBrave(
  query: string,
  count: number,
  freshness: string | undefined,
  apiKey: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(count) });
  // Brave expects coded freshness values (pd/pw/pm/py), not friendly names — map so the filter
  // is actually honored instead of silently ignored.
  if (freshness) {
    const code = { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[freshness] ?? freshness;
    params.set('freshness', code);
  }
  const url = `https://api.search.brave.com/res/v1/web/search?${params}`;

  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await braveThrottle();
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1500 * 2 ** attempt;
      console.warn(`[WebSearch] Brave 429 — retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${backoff}ms`);
      await sleep(backoff);
      continue;
    }

    if (!res.ok) throw new Error(`Brave API: ${res.status} ${res.statusText}`);

    const data = await res.json() as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };
    return (data.web?.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));
  }

  throw new Error('Brave API: 429 (rate limited after retries)');
}

async function searchPerplexity(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResult[]> {
  // Detect direct vs OpenRouter by key prefix
  const isOpenRouter = apiKey.toLowerCase().startsWith('sk-or-');
  const baseUrl = isOpenRouter
    ? 'https://openrouter.ai/api/v1'
    : 'https://api.perplexity.ai';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: isOpenRouter ? 'perplexity/sonar' : 'sonar',
      messages: [{ role: 'user', content: query }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Perplexity API: ${res.status}`);

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
  };

  const content = data.choices?.[0]?.message?.content ?? '';
  const citations = data.citations ?? [];

  // Perplexity returns prose + citations. Format as search results.
  return [{
    title: `Perplexity answer for: ${query}`,
    url: citations[0] ?? '',
    snippet: content.slice(0, 500),
  }];
}

async function searchGrok(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResult[]> {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-2',
      messages: [{ role: 'user', content: query }],
      search: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Grok API: ${res.status}`);

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content ?? '';

  return [{
    title: `Grok answer for: ${query}`,
    url: '',
    snippet: content.slice(0, 500),
  }];
}

async function searchTavily(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: count,
      search_depth: 'basic',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Tavily API: ${res.status}`);

  const data = await res.json() as {
    results?: Array<{ title: string; url: string; content: string }>;
  };

  return (data.results ?? []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

// Self-hosted SearXNG metasearch — no API key, no rate limit. Requires the instance's
// settings.yml to enable the JSON format (search.formats: [html, json]).
async function searchSearxng(
  query: string,
  count: number,
  freshness: string | undefined,
  baseUrl: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, format: 'json', language: 'en', safesearch: '0' });
  // SearXNG time_range only accepts day/month/year (NO week — per the search API docs).
  // Map our freshness vocabulary onto valid values; skip anything unrecognized.
  const timeRange = { day: 'day', week: 'month', month: 'month', year: 'year' }[freshness ?? ''];
  if (timeRange) params.set('time_range', timeRange);

  const url = `${baseUrl.replace(/\/+$/, '')}/search?${params}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'LocalClaw/1.0' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    if (res.status === 403) throw new Error('SearXNG 403 — enable the JSON format in settings.yml (search.formats: [html, json])');
    throw new Error(`SearXNG: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return (data.results ?? [])
    .filter(r => r.url)
    .slice(0, count)
    .map(r => ({
      title: r.title ?? r.url ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
    }));
}
