/**
 * Phase 9 - Lever application URL recognition.
 *
 * Deterministic and side-effect free: pure URL parsing, no network
 * requests. Recognizes the standard Lever careers host structurally - no
 * employer is hardcoded. Employer-branded custom careers sites (and local
 * test mirrors) can be supplied through `extraBoardHosts`.
 */

export interface LeverRecognitionOptions {
  /**
   * Additional hostnames that serve Lever application forms (e.g.
   * employer-branded custom careers domains, or local test mirrors in
   * tests). Never add private/internal hosts in production - navigation
   * to those is blocked by @jaa/browser SSRF validation regardless.
   */
  extraBoardHosts?: string[];
}

/** The one standard Lever careers host (app.lever.co is the recruiter dashboard - never claimed). */
const LEVER_BOARD_HOST = /^jobs\.lever\.co$/i;

/**
 * A posting/application page: `/{company}/{postingId}` optionally followed
 * by the `/apply` suffix Lever itself uses in `applyUrl`.
 */
const LEVER_APPLICATION_PATH = /^\/[^/]+\/[^/]+(?:\/apply)?\/?$/i;

/**
 * True when the URL points at a Lever application page. Pure function:
 * parsing only, never touches the network.
 */
export function isLeverApplicationUrl(url: string, options?: LeverRecognitionOptions): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Only plain web URLs; credential-bearing URLs are never claimed.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();

  // Custom-hosted Lever careers sites: the URL shape is employer-defined,
  // so only the host is checked (page inspection verifies the form).
  const extras = (options?.extraBoardHosts ?? []).map((h) => h.toLowerCase());
  if (extras.includes(host)) return true;

  if (!LEVER_BOARD_HOST.test(host)) return false;

  // On the standard host only posting/apply pages count - the board index
  // (`/{company}`) is not an application URL.
  return LEVER_APPLICATION_PATH.test(parsed.pathname);
}
