/**
 * Search source buckets — curated domain lists for topic-aware search.
 * Detects query topic via keywords, returns site-filtered queries that
 * prioritize credible sources while keeping random results for discovery.
 */

const SOURCE_BUCKETS: Record<string, string[]> = {
  ai_tech: [
    'anthropic.com', 'openai.com', 'ollama.com', 'huggingface.co',
    'arxiv.org', 'github.com', 'news.ycombinator.com',
    'deepmind.google', 'ai.meta.com', 'nvidia.com/blog',
    'lilianweng.github.io', 'jalammar.github.io', 'colah.github.io',
    'sebastianraschka.com', 'karpathy.ai', 'simonwillison.net',
  ],

  finance: [
    'finance.yahoo.com', 'bloomberg.com', 'seekingalpha.com',
    'sec.gov', 'reuters.com', 'wsj.com', 'ft.com',
    'macrotrends.net', 'finviz.com', 'cnbc.com',
  ],

  health: [
    'nih.gov', 'mayoclinic.org', 'pubmed.ncbi.nlm.nih.gov',
    'who.int', 'cdc.gov', 'webmd.com', 'healthline.com',
    'clevelandclinic.org', 'hopkinsmedicine.org',
  ],

  events: [
    'eventbrite.com', 'meetup.com', 'allevents.in',
    'lu.ma', 'facebook.com/events', 'eventeny.com',
  ],

  hardware: [
    'nvidia.com', 'servethehome.com', 'anandtech.com',
    'tomshardware.com', 'newegg.com', 'amazon.com',
    'techpowerup.com', 'pcworld.com',
  ],

  dev: [
    'stackoverflow.com', 'github.com', 'dev.to',
    'medium.com', 'npmjs.com', 'docs.python.org',
    'developer.mozilla.org', 'vercel.com/blog',
  ],

  news: [
    'reuters.com', 'apnews.com', 'bbc.com', 'nytimes.com',
    'theguardian.com', 'arstechnica.com', 'theverge.com',
    'wired.com', 'techcrunch.com',
  ],
};

const BUCKET_PATTERNS: Array<{ pattern: RegExp; bucket: string }> = [
  { pattern: /\b(stock|market|earnings|revenue|profit|investor|ipo|nasdaq|nyse|dividend|valuation)\b/i, bucket: 'finance' },
  { pattern: /\b(ai|llm|model|ollama|anthropic|openai|transformer|inference|training|neural|deep learning|machine learning|gpt|claude|gemma|qwen|llama)\b/i, bucket: 'ai_tech' },
  { pattern: /\b(health|medical|symptom|disease|treatment|doctor|hospital|diagnosis|medication|clinical)\b/i, bucket: 'health' },
  { pattern: /\b(event|conference|meetup|workshop|hackathon|networking|summit|expo)\b/i, bucket: 'events' },
  { pattern: /\b(gpu|server|rack|cpu|ram|nvme|hardware|build|workstation|benchmark)\b/i, bucket: 'hardware' },
  { pattern: /\b(npm|pip|python|javascript|typescript|react|node|api|code|programming|rust|golang|framework|library)\b/i, bucket: 'dev' },
  { pattern: /\b(news|latest|breaking|today|announced|launched|released|unveiled)\b/i, bucket: 'news' },
];

/** Detect which source bucket matches a query. Returns null for general/unclassified. */
export function detectBucket(query: string): string | null {
  for (const { pattern, bucket } of BUCKET_PATTERNS) {
    if (pattern.test(query)) return bucket;
  }
  return null;
}

/** Get the source domains for a bucket. */
export function getBucketSources(bucket: string): string[] {
  return SOURCE_BUCKETS[bucket] ?? [];
}

/**
 * Build a site-filtered search query from a bucket.
 * Picks 3-5 random domains from the bucket and creates an OR filter.
 * Returns null if no bucket or empty bucket.
 */
export function buildSiteFilter(bucket: string, maxSites = 4): string | null {
  const sites = SOURCE_BUCKETS[bucket];
  if (!sites?.length) return null;

  const shuffled = [...sites].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, maxSites);
  return selected.map(s => `site:${s}`).join(' OR ');
}

/**
 * Prioritize URLs from curated sources over random results.
 * Returns URLs sorted: curated domains first, then the rest in original order.
 */
export function prioritizeUrls(urls: string[], bucket: string | null): string[] {
  if (!bucket) return urls;
  const sites = SOURCE_BUCKETS[bucket] ?? [];
  if (sites.length === 0) return urls;

  const curated: string[] = [];
  const other: string[] = [];

  for (const url of urls) {
    const isCurated = sites.some(s => url.includes(s));
    if (isCurated) curated.push(url);
    else other.push(url);
  }

  return [...curated, ...other];
}
