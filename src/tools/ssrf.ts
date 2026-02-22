import { lookup } from 'node:dns/promises';
import { ssrfBlocked } from '../errors.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.internal.',
  '169.254.169.254',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal'];

/** Only allow http: and https: schemes */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export function isPrivateIpAddress(ip: string): boolean {
  // IPv4 private ranges
  if (/^0\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^127\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  // 172.16.0.0 – 172.31.255.255
  const m172 = ip.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  // CGN: 100.64.0.0 – 100.127.255.255
  const m100 = ip.match(/^100\.(\d+)\./);
  if (m100 && Number(m100[1]) >= 64 && Number(m100[1]) <= 127) return true;

  // IPv6 loopback and private
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, ''); // strip brackets
  if (lower === '::1' || lower === '::') return true;
  if (/^fe80:/i.test(lower)) return true;   // link-local
  if (/^fec0:/i.test(lower)) return true;   // site-local (deprecated)
  if (/^f[cd]/i.test(lower)) return true;   // unique local (fc00::/7)
  if (/^ff/i.test(lower)) return true;      // multicast

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpAddress(mapped[1]);

  // IPv4-compatible IPv6 (::x.x.x.x)
  const compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (compat) return isPrivateIpAddress(compat[1]);

  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  return BLOCKED_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

/**
 * Assert that a URL resolves to a public address. Throws ssrfBlocked if not.
 *
 * Checks:
 * 1. Scheme must be http: or https: (blocks file://, ftp://, gopher://, etc.)
 * 2. Hostname must not be blocked
 * 3. Resolved IPs must not be private (IPv4 and IPv6)
 * 4. Handles IPv6 bracket notation [::1]
 */
export async function assertPublicUrl(urlStr: string): Promise<void> {
  let url: URL;
  try {
    // WHATWG URL parser for consistent normalization
    url = new URL(urlStr);
  } catch {
    throw ssrfBlocked(urlStr);
  }

  // Block non-HTTP schemes (file://, ftp://, gopher://, data:, javascript:, etc.)
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw ssrfBlocked(urlStr);
  }

  // Normalize hostname (strip IPv6 brackets, lowercase)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (isBlockedHostname(hostname)) {
    throw ssrfBlocked(urlStr);
  }

  // Check if hostname is already an IP (IPv4 or IPv6)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    if (isPrivateIpAddress(hostname)) {
      throw ssrfBlocked(urlStr);
    }
    return;
  }

  // DNS lookup to check all resolved IPs
  try {
    const result = await lookup(hostname, { all: true });
    const addresses = Array.isArray(result) ? result : [result];
    for (const addr of addresses) {
      if (isPrivateIpAddress(addr.address)) {
        throw ssrfBlocked(urlStr);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SSRF blocked')) throw err;
    // DNS failure — allow through (will fail at fetch)
  }
}

/**
 * Validate a redirect URL against SSRF rules.
 * Call this on each redirect hop to prevent DNS rebinding attacks.
 */
export async function assertPublicRedirect(originalUrl: string, redirectUrl: string): Promise<void> {
  // Parse redirect relative to original
  let resolved: URL;
  try {
    resolved = new URL(redirectUrl, originalUrl);
  } catch {
    throw ssrfBlocked(redirectUrl);
  }
  await assertPublicUrl(resolved.toString());
}
