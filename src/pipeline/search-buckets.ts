/**
 * Search source buckets — curated domain lists for topic-aware search.
 * Detects query topic via keywords, returns site-filtered queries that
 * prioritize credible sources while keeping random results for discovery.
 *
 * ANCHOR CONVENTION: the FIRST 2 domains of each bucket are "anchors" — always
 * included in the site filter. The rest are sampled randomly. This guarantees
 * high-value sources (e.g. civic open data for real_estate) reliably appear
 * instead of being diluted by random selection.
 */

const ANCHOR_COUNT = 2;

const SOURCE_BUCKETS: Record<string, string[]> = {
  ai_tech: [
    'huggingface.co', 'anthropic.com',   // anchors — model registry + frontier lab, always included
    'openai.com', 'ollama.com',
    'arxiv.org', 'github.com', 'news.ycombinator.com',
    'deepmind.google', 'ai.meta.com', 'nvidia.com/blog',
    'lilianweng.github.io', 'jalammar.github.io', 'colah.github.io',
    'sebastianraschka.com', 'karpathy.ai', 'simonwillison.net',
  ],

  finance: [
    'finance.yahoo.com', 'bloomberg.com', 'seekingalpha.com',
    'sec.gov', 'reuters.com', 'wsj.com', 'ft.com',
    'macrotrends.net', 'finviz.com', 'cnbc.com',
    'data.cityofnewyork.us', 'data.ny.gov',   // civic: business/budget/assessment data
  ],

  health: [
    'nih.gov', 'mayoclinic.org', 'pubmed.ncbi.nlm.nih.gov',
    'who.int', 'cdc.gov', 'webmd.com', 'healthline.com',
    'clevelandclinic.org', 'hopkinsmedicine.org',
    'data.cityofnewyork.us', 'data.ny.gov',   // civic: public health / social services data
  ],

  events: [
    'eventbrite.com', 'meetup.com', 'allevents.in',
    'lu.ma', 'facebook.com/events', 'eventeny.com',
    'data.cityofnewyork.us', 'data.ny.gov',   // civic: recreation / parks / events data
  ],

  hardware: [
    'servethehome.com', 'anandtech.com',   // anchors — deep coverage of new AI hardware (DGX Spark, Strix Halo, RTX)
    'nvidia.com', 'amd.com',
    'tomshardware.com', 'techpowerup.com',
    'newegg.com', 'pcworld.com', 'phoronix.com',
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
    'data.cityofnewyork.us', 'data.ny.gov',   // civic: city gov / public safety data
  ],

  // Anchors (always included): civic/parcel open data. Then ACRIS + listing sites.
  real_estate: [
    'data.cityofnewyork.us', 'data.ny.gov',   // anchors — civic/parcel/open data
    'acris.nyc.gov', 'propertyshark.com',
    'loopnet.com', 'crexi.com',                // CRE listings
    'zillow.com', 'realtor.com', 'streeteasy.com',  // residential
  ],
};

const BUCKET_PATTERNS: Array<{ pattern: RegExp; bucket: string }> = [
  // real_estate MUST precede finance — "off market"/"real estate market" contain "market" (a finance keyword).
  // Stems use leading \b only (no trailing) so plurals/suffixes match: properties, listings, foreclosure.
  { pattern: /\b(propert|parcel|real estate|off.?market|listing|zoning|foreclos|lien|deed|realtor|mls|condo|co-?ops?\b)/i, bucket: 'real_estate' },
  { pattern: /\b(stock|market|earnings|revenue|profit|investor|ipo|nasdaq|nyse|dividend|valuation)\b/i, bucket: 'finance' },
  // hardware MUST precede ai_tech — "GPU/hardware for inference" else gets stolen by ai_tech's "inference".
  // Product lines (rtx/radeon/ryzen/dgx/strix...) are unambiguous hardware; bare "nvidia/amd" stay out
  // (they collide with finance "stock"). "hardware" word + components route here.
  { pattern: /\b(gpu|hardware|rtx|radeon|geforce|ryzen|threadripper|epyc|strix|dgx|instinct|tensor core|vram|npu|workstation|server|rack|nvme|motherboard)\b/i, bucket: 'hardware' },
  { pattern: /\b(ai|llm|model|ollama|anthropic|openai|transformer|inference|training|neural|deep learning|machine learning|gpt|claude|gemma|qwen|llama)\b/i, bucket: 'ai_tech' },
  { pattern: /\b(health|medical|symptom|disease|treatment|doctor|hospital|diagnosis|medication|clinical)\b/i, bucket: 'health' },
  { pattern: /\b(event|conference|meetup|workshop|hackathon|networking|summit|expo)\b/i, bucket: 'events' },
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
 * Always includes the bucket's anchor domains (first ANCHOR_COUNT entries),
 * then fills the remaining slots with a random sample of the rest.
 * Returns null if no bucket or empty bucket.
 */
export function buildSiteFilter(bucket: string, maxSites = 4): string | null {
  const sites = SOURCE_BUCKETS[bucket];
  if (!sites?.length) return null;

  const anchors = sites.slice(0, ANCHOR_COUNT);
  const rest = sites.slice(ANCHOR_COUNT);
  const remainingSlots = Math.max(0, maxSites - anchors.length);
  const sampled = [...rest].sort(() => Math.random() - 0.5).slice(0, remainingSlots);

  const selected = [...anchors, ...sampled];
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
