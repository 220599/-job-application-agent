import { UrlBlockedError, InvalidUrlError } from './errors';

/**
 * SSRF protection for the browser automation layer (Phase 6).
 *
 * This mirrors and extends the Phase 4 job-ingestion URL validation:
 *  - only http/https protocols (file:, javascript:, data:, ftp: etc. rejected)
 *  - localhost / loopback / private ranges / link-local / metadata hosts blocked
 *  - credentials in URLs rejected
 *  - IPv4 AND IPv6 (including IPv4-mapped) handled
 *
 * The Phase 4 validator in apps/api/src/services/job-ingestion.ts remains
 * untouched; this module never weakens it - it applies at least the same
 * rules before the browser is allowed to navigate anywhere.
 *
 * `allowPrivateUrls` (config PLAYWRIGHT_ALLOW_PRIVATE_URLS) exists ONLY for
 * local development and test fixtures (the mock ATS server runs on
 * 127.0.0.1). It is off by default and must never be enabled in production.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  '169.254.169.254',
  '0.0.0.0',
]);

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((p) => p === '' || Number.isNaN(Number(p)))) {
    return false;
  }
  const [a, b] = parts.map((p) => parseInt(p, 10));
  if (a === 0 || a === 10 || a === 127) return true; // loopback, private, this-network
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // IPv4-mapped (::ffff:10.0.0.1) - extract and check the IPv4 side
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    return true; // link-local fe80::/10
  }
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local fc00::/7
  return false;
}

function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    BLOCKED_HOSTNAMES.has(h) ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.localdomain')
  );
}

export interface UrlValidationOptions {
  /** Allow loopback/private URLs (local test fixtures only). Default: false. */
  allowPrivate?: boolean;
}

export type UrlValidationResult =
  | { valid: true; url: string }
  | { valid: false; reason: string };

export function validatePublicHttpUrl(
  rawUrl: string,
  options?: UrlValidationOptions
): UrlValidationResult {
  const allowPrivate = options?.allowPrivate ?? false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, reason: 'URL could not be parsed' };
  }

  // Protocol check happens regardless of allowPrivate: file:, javascript:,
  // data:, ftp: and friends are never allowed in the browser layer.
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, reason: `Protocol "${parsed.protocol}" is not allowed` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'URLs with embedded credentials are not allowed' };
  }

  if (!allowPrivate) {
    const hostname = parsed.hostname.toLowerCase();
    if (isInternalHostname(hostname)) {
      return { valid: false, reason: `Host "${hostname}" is not allowed` };
    }
    if (isPrivateIPv4(hostname)) {
      return { valid: false, reason: `Private/reserved IPv4 address is not allowed` };
    }
    if (hostname.includes(':') && isPrivateIPv6(hostname)) {
      return { valid: false, reason: `Private/reserved IPv6 address is not allowed` };
    }
    // Bare IPv6 literal that slipped through without brackets
    if (hostname.includes(':') && !hostname.startsWith('[') && hostname.includes('::')) {
      return { valid: false, reason: 'IPv6 address is not allowed' };
    }
  }

  return { valid: true, url: parsed.toString() };
}

/** Validation that throws typed errors, for the navigation layer. */
export function assertPublicHttpUrl(rawUrl: string, options?: UrlValidationOptions): string {
  const result = validatePublicHttpUrl(rawUrl, options);
  if (!result.valid) {
    const isParseFailure = result.reason.includes('could not be parsed');
    if (isParseFailure) throw new InvalidUrlError(result.reason, rawUrl);
    throw new UrlBlockedError(result.reason, rawUrl);
  }
  return result.url;
}
