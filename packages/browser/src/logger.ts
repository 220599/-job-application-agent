import type { ILogger } from '@jaa/shared';

/**
 * Structured event logging for browser operations (Phase 6).
 *
 * Events are logged WITHOUT secrets: we log URLs, durations, status codes
 * and file sizes - never cookies, tokens, credentials or page content.
 * Higher layers can plug their own logger (e.g. the winston logger used by
 * the API) via setBrowserLogger; the default writes structured lines to
 * the console.
 */

export type BrowserEventType =
  | 'BROWSER_LAUNCHING'
  | 'BROWSER_STARTED'
  | 'BROWSER_CLOSED'
  | 'CONTEXT_CREATED'
  | 'CONTEXT_CLOSED'
  | 'PAGE_CREATED'
  | 'NAVIGATION_STARTED'
  | 'NAVIGATION_COMPLETED'
  | 'NAVIGATION_REDIRECTED'
  | 'NAVIGATION_FAILED'
  | 'ACTION_PERFORMED'
  | 'SCREENSHOT_CREATED'
  | 'BROWSER_EVENT';

let externalLogger: ILogger | null = null;

/** Plug the application logger (e.g. the API's winston logger). */
export function setBrowserLogger(logger: ILogger): void {
  externalLogger = logger;
}

export function getBrowserLogger(): ILogger | null {
  return externalLogger;
}

export function logBrowserEvent(
  event: BrowserEventType,
  meta?: Record<string, unknown>
): void {
  const entry = {
    event,
    timestamp: new Date().toISOString(),
    ...meta,
  };
  if (externalLogger) {
    externalLogger.info(`[BROWSER] ${event}`, meta);
    return;
  }
  // Default: single structured line on the console
  console.log(`[BROWSER] ${JSON.stringify(entry)}`);
}
