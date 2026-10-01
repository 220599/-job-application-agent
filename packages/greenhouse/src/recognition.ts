/**
 * Phase 8 - Greenhouse application URL recognition.
 *
 * Deterministic and side-effect free: pure URL parsing, no network requests.
 * The standard Greenhouse job-board hosts are recognized structurally - no
 * employer is hardcoded. Employer-branded custom boards (and local test
 * mirrors) can be supplied through `extraBoardHosts`.
 */

export interface GreenhouseRecognitionOptions {
  /**
   * Additional hostnames that serve Greenhouse application forms (e.g.
   * employer-branded custom domains, or local test mirrors in tests).
   * Never add private/internal hosts in production - navigation to those
   * is blocked by @jaa/browser SSRF validation regardless.
   */
  extraBoardHosts?: string[];
}

/**
 * Greenhouse-owned job board hosts, including regional variants such as
 * `boards.eu.greenhouse.io`. API hosts (boards-api.greenhouse.io,
 * api.greenhouse.io) deliberately do NOT match - they are not application
 * forms.
 */
const GREENHOUSE_BOARD_HOST = /^(?:job-boards|boards)(?:\.[a-z]{2})?\.greenhouse\.io$/i;

/** A job/application page: `/{company}/jobs/{id}...` or the legacy embed form. */
const GREENHOUSE_APPLICATION_PATH = /(?:^|\/)jobs\/[^/]+/i;
const GREENHOUSE_EMBED_PATH = /^\/embed\/job_app(?:\/|$|\?)/i;

/**
 * True when the URL points at a Greenhouse application page. Pure function:
 * parsing only, never touches the network.
 */
export function isGreenhouseApplicationUrl(
  url: string,
  options?: GreenhouseRecognitionOptions
): boolean {
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

  // Custom-hosted Greenhouse boards: the URL shape is employer-defined, so
  // only the host is checked (the page inspection verifies the form).
  const extras = (options?.extraBoardHosts ?? []).map((h) => h.toLowerCase());
  if (extras.includes(host)) return true;

  if (!GREENHOUSE_BOARD_HOST.test(host)) return false;

  // On the standard hosts only job/application pages count - a board index
  // (`/{company}`) or other pages are not application URLs.
  const path = parsed.pathname.toLowerCase();
  return GREENHOUSE_APPLICATION_PATH.test(path) || GREENHOUSE_EMBED_PATH.test(path);
}
