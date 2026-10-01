/**
 * Browser automation error types.
 *
 * All errors carry a machine-readable `code` so higher layers (worker,
 * AutomationRun tracking, Phase 7+) can branch without string matching.
 */

export type BrowserErrorCode =
  | 'URL_BLOCKED'
  | 'INVALID_URL'
  | 'NAVIGATION_TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'HTTP_ERROR'
  | 'BROWSER_NOT_LAUNCHED'
  | 'BROWSER_ERROR';

export class BrowserError extends Error {
  constructor(
    public code: BrowserErrorCode,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}

/** URL rejected by SSRF validation. `reason` says which rule fired. */
export class UrlBlockedError extends BrowserError {
  constructor(reason: string, public url?: string) {
    super('URL_BLOCKED', `URL blocked by security policy: ${reason}`, { url });
    this.name = 'UrlBlockedError';
  }
}

export class InvalidUrlError extends BrowserError {
  constructor(reason: string, public url?: string) {
    super('INVALID_URL', `Invalid URL: ${reason}`, { url });
    this.name = 'InvalidUrlError';
  }
}

export class NavigationTimeoutError extends BrowserError {
  constructor(url: string, timeoutMs: number) {
    super('NAVIGATION_TIMEOUT', `Navigation timed out after ${timeoutMs}ms`, { url });
    this.name = 'NavigationTimeoutError';
  }
}

export class HttpNavigationError extends BrowserError {
  constructor(public statusCode: number, url: string) {
    super('HTTP_ERROR', `Page responded with HTTP ${statusCode}`, { url });
    this.name = 'HttpNavigationError';
  }
}

export class NavigationFailedError extends BrowserError {
  constructor(message: string, url?: string) {
    super('NAVIGATION_FAILED', message, { url });
    this.name = 'NavigationFailedError';
  }
}

export function isBrowserError(err: unknown): err is BrowserError {
  return err instanceof BrowserError;
}
