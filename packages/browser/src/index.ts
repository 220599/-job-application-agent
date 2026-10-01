/**
 * @jaa/browser - Playwright browser automation foundation (Phase 6).
 *
 * Public API - the rest of the application never imports Playwright
 * directly:
 *
 *   import { launchBrowser, closeBrowser } from '@jaa/browser';
 *
 *   const browser = await launchBrowser();         // reused across operations
 *   const context = await browser.createContext(); // isolated per run/user
 *   const page = await context.createPage();
 *   const result = await page.navigate(url);       // SSRF-validated
 *   const title = await page.getTitle();
 *   const shot  = await page.screenshot('step');
 *   await context.close();
 *   await closeBrowser();
 */

// Browser manager
export {
  JaaBrowser,
  JaaBrowserContext,
  JaaPage,
  launchBrowser,
  closeBrowser,
} from './browser';
export type {
  LaunchOptions,
  NavigateOptions,
  WaitForPageOptions,
  ContextOptions,
  NavigationResult,
} from './browser';

// Configuration
export { getBrowserConfig } from './config';
export type { BrowserConfig } from './config';

// Security
export { validatePublicHttpUrl, assertPublicHttpUrl } from './url-validation';
export type { UrlValidationOptions, UrlValidationResult } from './url-validation';

// Errors
export {
  BrowserError,
  UrlBlockedError,
  InvalidUrlError,
  NavigationTimeoutError,
  NavigationFailedError,
  HttpNavigationError,
  isBrowserError,
} from './errors';
export type { BrowserErrorCode } from './errors';

// Structured events
export { logBrowserEvent, setBrowserLogger } from './logger';
export type { BrowserEventType } from './logger';
