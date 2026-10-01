import { chromium } from 'playwright';
import type {
  Browser as PlaywrightBrowser,
  BrowserContext as PlaywrightBrowserContext,
  Page as PlaywrightPage,
} from 'playwright';
import fs from 'fs/promises';
import path from 'path';

import { getBrowserConfig, type BrowserConfig } from './config';
import { assertPublicHttpUrl } from './url-validation';
import { logBrowserEvent } from './logger';
import {
  HttpNavigationError,
  NavigationFailedError,
  NavigationTimeoutError,
} from './errors';

// ============================================================================
// Public types
// ============================================================================

export interface LaunchOptions {
  /** Run without a visible window. Default: PLAYWRIGHT_HEADLESS ?? true */
  headless?: boolean;
  /** Debug aid: delay between Playwright actions (ms). */
  slowMoMs?: number;
  /** Allow localhost/private URLs (local test fixtures only). Default: false. */
  allowPrivateUrls?: boolean;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  screenshotDir?: string;
}

export interface NavigationResult {
  /** Final URL after any redirects */
  url: string;
  /** HTTP status code of the response, when available */
  status: number | null;
  /** Whether the final URL differs from the requested URL */
  redirected: boolean;
}

export interface NavigateOptions {
  /** Override the configured navigation timeout for this call. */
  timeoutMs?: number;
  /** Wait strategy for goto. Default: 'load'. */
  waitUntil?: 'load' | 'domcontentloaded' | 'commit';
}

export interface WaitForPageOptions {
  /** Wait for a CSS selector to appear (e.g. a form field). */
  selector?: string;
  timeoutMs?: number;
}

export interface ContextOptions {
  viewport?: { width: number; height: number };
  userAgent?: string;
}

// ============================================================================
// Page wrapper
// ============================================================================

/**
 * Wrapper around a Playwright Page. All navigation goes through SSRF URL
 * validation, structured logging, and error normalization. Callers never
 * touch the Playwright API directly.
 */
export class JaaPage {
  constructor(
    private readonly pwPage: PlaywrightPage,
    private readonly config: BrowserConfig
  ) {}

  /**
   * Navigate to a URL after security validation. Handles navigation
   * timeouts, failed navigations, detectable HTTP errors, and logs
   * unexpected redirects.
   */
  async navigate(url: string, options?: NavigateOptions): Promise<NavigationResult> {
    // SSRF guard - throws UrlBlockedError/InvalidUrlError on rejection.
    const safeUrl = assertPublicHttpUrl(url, {
      allowPrivate: this.config.allowPrivateUrls,
    });

    const timeoutMs = options?.timeoutMs ?? this.config.navigationTimeoutMs;
    logBrowserEvent('NAVIGATION_STARTED', { url: safeUrl, timeoutMs });

    try {
      const response = await this.pwPage.goto(safeUrl, {
        waitUntil: options?.waitUntil ?? 'load',
        timeout: timeoutMs,
      });
      // Give late scripts/styles a brief chance to settle; never fail the
      // navigation just because the load state timed out after goto.
      await this.pwPage
        .waitForLoadState('load', { timeout: Math.min(timeoutMs, 10_000) })
        .catch(() => undefined);

      const finalUrl = this.pwPage.url();
      const redirected = finalUrl.replace(/\/$/, '') !== safeUrl.replace(/\/$/, '');
      const status = response?.status() ?? null;

      if (redirected) {
        logBrowserEvent('NAVIGATION_REDIRECTED', { from: safeUrl, to: finalUrl });
      }

      if (status !== null && status >= 400) {
        logBrowserEvent('NAVIGATION_FAILED', { url: finalUrl, status });
        throw new HttpNavigationError(status, finalUrl);
      }

      logBrowserEvent('NAVIGATION_COMPLETED', { url: finalUrl, status, redirected });
      return { url: finalUrl, status, redirected };
    } catch (err) {
      if (err instanceof HttpNavigationError) throw err;
      if (err instanceof NavigationFailedError) throw err;
      if (err instanceof Error && err.name === 'TimeoutError') {
        logBrowserEvent('NAVIGATION_FAILED', { url: safeUrl, error: 'timeout' });
        throw new NavigationTimeoutError(safeUrl, timeoutMs);
      }
      const message = err instanceof Error ? err.message : String(err);
      // net::ERR_* failures surface as generic playwright errors
      logBrowserEvent('NAVIGATION_FAILED', { url: safeUrl, error: message });
      throw new NavigationFailedError(message, safeUrl);
    }
  }

  /**
   * Wait for the page to be usable: load state settled, plus an optional
   * selector that must appear.
   */
  async waitForPage(options?: WaitForPageOptions): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? this.config.actionTimeoutMs;
    await this.pwPage.waitForLoadState('load', { timeout: timeoutMs });
    if (options?.selector) {
      await this.pwPage.waitForSelector(options.selector, { timeout: timeoutMs });
    }
  }

  getCurrentUrl(): string {
    return this.pwPage.url();
  }

  async getTitle(): Promise<string> {
    return this.pwPage.title();
  }

  /** Full HTML of the current page. Never logged by this layer. */
  async getPageContent(): Promise<string> {
    return this.pwPage.content();
  }

  /**
   * Capture a screenshot into the configured screenshot directory.
   * Returns the absolute path of the written file.
   */
  async screenshot(name = 'screenshot'): Promise<string> {
    const dir = this.config.screenshotDir;
    await fs.mkdir(dir, { recursive: true });
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_');
    const filePath = path.join(dir, `${Date.now()}-${safeName}.png`);
    await this.pwPage.screenshot({ path: filePath, fullPage: true });
    logBrowserEvent('SCREENSHOT_CREATED', { path: filePath });
    return filePath;
  }

  // ------------------------------------------------------------------------
  // Minimal, generic interaction helpers (used by mock-page flows and later
  // phases). They log what was done, never the values.
  // ------------------------------------------------------------------------

  async fill(selector: string, value: string): Promise<void> {
    await this.pwPage.fill(selector, value, { timeout: this.config.actionTimeoutMs });
    logBrowserEvent('ACTION_PERFORMED', { action: 'fill', selector });
  }

  async click(selector: string): Promise<void> {
    await this.pwPage.click(selector, { timeout: this.config.actionTimeoutMs });
    logBrowserEvent('ACTION_PERFORMED', { action: 'click', selector });
  }

  async setInputFiles(selector: string, files: string[]): Promise<void> {
    await this.pwPage.setInputFiles(selector, files, { timeout: this.config.actionTimeoutMs });
    logBrowserEvent('ACTION_PERFORMED', { action: 'setInputFiles', selector, fileCount: files.length });
  }

  async waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
    await this.pwPage.waitForSelector(selector, {
      timeout: timeoutMs ?? this.config.actionTimeoutMs,
    });
  }

  /** Run JS in the page (advanced use, e.g. storage-state isolation checks). */
  async evaluate<T>(pageFunction: string | ((arg?: unknown) => T)): Promise<T> {
    return this.pwPage.evaluate(pageFunction);
  }
}

// ============================================================================
// Context wrapper - one isolated context per automation run
// ============================================================================

export class JaaBrowserContext {
  constructor(
    private readonly pwContext: PlaywrightBrowserContext,
    private readonly config: BrowserConfig
  ) {
    pwContext.setDefaultTimeout(config.actionTimeoutMs);
    pwContext.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  }

  async createPage(): Promise<JaaPage> {
    const page = await this.pwContext.newPage();
    logBrowserEvent('PAGE_CREATED');
    return new JaaPage(page, this.config);
  }

  async close(): Promise<void> {
    await this.pwContext.close();
    logBrowserEvent('CONTEXT_CLOSED');
  }
}

// ============================================================================
// Browser wrapper + shared-instance manager
// ============================================================================

export class JaaBrowser {
  constructor(
    private readonly pwBrowser: PlaywrightBrowser,
    public readonly config: BrowserConfig
  ) {}

  isOpen(): boolean {
    return this.pwBrowser.isConnected();
  }

  version(): string {
    return this.pwBrowser.version();
  }

  /**
   * Create a fresh, isolated browser context (own cookies, storage, cache).
   * Never share a context between users or automation runs.
   *
   * `allowPrivateUrls` can be tightened per context (e.g. a context that
   * must never touch internal hosts); it defaults to the browser-level
   * setting. It can only ever be MORE restrictive than the browser itself:
   * a browser launched without allowPrivateUrls can never unlock private
   * URLs from a context.
   */
  async createContext(
    options?: ContextOptions & { allowPrivateUrls?: boolean }
  ): Promise<JaaBrowserContext> {
    const pwContext = await this.pwBrowser.newContext({
      viewport: options?.viewport ?? { width: 1280, height: 800 },
      userAgent: options?.userAgent,
    });
    logBrowserEvent('CONTEXT_CREATED');
    const contextConfig: BrowserConfig = {
      ...this.config,
      allowPrivateUrls: (options?.allowPrivateUrls ?? this.config.allowPrivateUrls)
        && this.config.allowPrivateUrls,
    };
    return new JaaBrowserContext(pwContext, contextConfig);
  }

  async close(): Promise<void> {
    if (this.pwBrowser.isConnected()) {
      await this.pwBrowser.close();
      logBrowserEvent('BROWSER_CLOSED');
    }
  }
}

// ----------------------------------------------------------------------------
// Shared-instance manager: one browser process reused for many operations.
// ----------------------------------------------------------------------------

let sharedBrowser: JaaBrowser | null = null;
let launching: Promise<JaaBrowser> | null = null;

/**
 * Launch (or reuse) the shared Playwright browser. The browser is reused
 * across page operations; each operation still gets its own isolated
 * context via browser.createContext().
 */
export async function launchBrowser(options?: LaunchOptions): Promise<JaaBrowser> {
  if (sharedBrowser && sharedBrowser.isOpen()) {
    return sharedBrowser;
  }
  if (launching) {
    return launching;
  }

  launching = (async () => {
    const config: BrowserConfig = {
      ...getBrowserConfig(),
      ...options,
    };
    logBrowserEvent('BROWSER_LAUNCHING', { headless: config.headless });
    const pwBrowser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMoMs,
    });
    sharedBrowser = new JaaBrowser(pwBrowser, config);
    logBrowserEvent('BROWSER_STARTED', { version: pwBrowser.version() });
    return sharedBrowser;
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

/** Close the shared browser and release all its resources. */
export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    const browser = sharedBrowser;
    sharedBrowser = null;
    await browser.close();
  }
}
