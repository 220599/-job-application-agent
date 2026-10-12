import { chromium } from 'playwright';
import type {
  Browser as PlaywrightBrowser,
  BrowserContext as PlaywrightBrowserContext,
  Frame as PlaywrightFrame,
  Page as PlaywrightPage,
} from 'playwright';
import fs from 'fs/promises';
import path from 'path';

import { getBrowserConfig, type BrowserConfig } from './config';
import { assertPublicHttpUrl, validatePublicHttpUrl } from './url-validation';
import { logBrowserEvent } from './logger';
import {
  HttpNavigationError,
  InvalidUrlError,
  NavigationFailedError,
  NavigationTimeoutError,
  UrlBlockedError,
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

export interface FrameLookupOptions {
  /**
   * Exact origins (protocol+host+port) allowed for a CROSS-ORIGIN child
   * frame. Frames on the page's own origin are always allowed. Cross-origin
   * frames outside this list are never entered.
   */
  allowedOrigins?: string[];
  /**
   * Host suffixes allowed for a cross-origin child frame (e.g.
   * `greenhouse.io` allows `job-boards.greenhouse.io` and
   * `boards.eu.greenhouse.io`). A suffix only ever matches a full label
   * boundary: `greenhouse.io` never matches `notgreenhouse.io`.
   */
  allowedOriginSuffixes?: string[];
  /** How long to wait for a qualifying frame to appear. */
  timeoutMs?: number;
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

  /** Select an option in a <select> by value. Logs the selector, never the value. */
  async selectOption(selector: string, value: string): Promise<void> {
    await this.pwPage.selectOption(selector, value, { timeout: this.config.actionTimeoutMs });
    logBrowserEvent('ACTION_PERFORMED', { action: 'selectOption', selector });
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

  // ------------------------------------------------------------------------
  // Narrow, SSRF-safe iframe interaction (Phase 15B.1).
  // ------------------------------------------------------------------------

  /** Origin of the current main document ('null' when it has none). */
  private currentOrigin(): string {
    try {
      return new URL(this.pwPage.url()).origin.toLowerCase();
    } catch {
      return 'null';
    }
  }

  /**
   * Resolve the first child frame that contains `selector` - the ONLY way
   * code outside this package ever interacts with iframe content. The
   * restrictions never relax:
   *
   *  - every candidate frame URL passes the same SSRF policy as navigation
   *    (private/loopback/metadata hosts and non-http protocols are skipped
   *    unless the browser was explicitly launched with allowPrivateUrls);
   *  - frames are same-origin by DEFAULT; a cross-origin frame is only ever
   *    entered when its origin is explicitly allowed (`allowedOrigins`) or
   *    its host matches an allowed provider suffix (`allowedOriginSuffixes`);
   *  - there is no API to NAVIGATE a frame anywhere - interaction stays
   *    inside the frame the page itself loaded;
   *  - the returned handle re-validates URL and origin on EVERY call, so a
   *    frame that later navigates to a blocked URL refuses interaction.
   */
  async frameContaining(
    selector: string,
    options?: FrameLookupOptions
  ): Promise<JaaFrame | null> {
    const timeoutMs = options?.timeoutMs ?? this.config.actionTimeoutMs;
    const allowedOrigins = (options?.allowedOrigins ?? []).map((o) => o.toLowerCase());
    const allowedOriginSuffixes = (options?.allowedOriginSuffixes ?? []).map((s) =>
      s.toLowerCase()
    );
    const pageOrigin = this.currentOrigin();
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      for (const pwFrame of this.pwPage.frames()) {
        if (pwFrame === this.pwPage.mainFrame()) continue;
        const frameUrl = pwFrame.url();

        // SSRF guard - identical policy to navigation.
        const check = validatePublicHttpUrl(frameUrl, {
          allowPrivate: this.config.allowPrivateUrls,
        });
        if (!check.valid) {
          logBrowserEvent('BROWSER_EVENT', {
            action: 'FRAME_BLOCKED',
            reason: check.reason,
          });
          continue;
        }

        // Origin guard - same-origin by default, explicit opt-in for more.
        const parsed = new URL(check.url);
        const origin = parsed.origin.toLowerCase();
        const host = parsed.hostname.toLowerCase();
        const originOk =
          origin === pageOrigin ||
          allowedOrigins.includes(origin) ||
          allowedOriginSuffixes.some((suffix) => {
            const bare = suffix.replace(/^\.+/, '');
            return host === bare || host.endsWith(`.${bare}`);
          });
        if (!originOk) {
          logBrowserEvent('BROWSER_EVENT', {
            action: 'FRAME_BLOCKED',
            reason: 'frame origin is not allowed',
            origin,
          });
          continue;
        }

        let contains = false;
        try {
          contains = (await pwFrame.evaluate(
            `(function (s) { return document.querySelector(s) !== null; })(${JSON.stringify(selector)})`
          )) as boolean;
        } catch {
          // Frame detached or not committed yet - try again on the next pass.
          continue;
        }
        if (contains) {
          logBrowserEvent('BROWSER_EVENT', { action: 'FRAME_SELECTED', origin });
          return new JaaFrame(pwFrame, this.config, allowedOriginSuffixes, [
            pageOrigin,
            ...allowedOrigins,
          ]);
        }
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

// ============================================================================
// Frame wrapper - narrow, validated interaction with iframe content
// ============================================================================

/**
 * Wrapper around a Playwright Frame, produced ONLY by
 * `JaaPage.frameContaining`. It exposes the same minimal interaction subset
 * as {@link JaaPage} and re-validates the frame URL and origin before EVERY
 * call: a frame that navigated to a blocked URL or a disallowed origin is
 * refused from that point on. There is no navigation API.
 */
export class JaaFrame {
  constructor(
    private readonly pwFrame: PlaywrightFrame,
    private readonly config: BrowserConfig,
    private readonly allowedOriginSuffixes: string[],
    private readonly allowedOrigins: string[]
  ) {}

  url(): string {
    return this.pwFrame.url();
  }

  /** Re-validate SSRF policy + origin policy on every interaction. */
  private assertUsable(): string {
    const frameUrl = this.pwFrame.url();
    const safeUrl = assertPublicHttpUrl(frameUrl, {
      allowPrivate: this.config.allowPrivateUrls,
    });
    let origin = 'null';
    let host = '';
    try {
      const parsed = new URL(safeUrl);
      origin = parsed.origin.toLowerCase();
      host = parsed.hostname.toLowerCase();
    } catch {
      throw new InvalidUrlError('Frame URL could not be parsed', frameUrl);
    }
    const originOk =
      this.allowedOrigins.includes(origin) ||
      this.allowedOriginSuffixes.some((suffix) => {
        const bare = suffix.replace(/^\.+/, '');
        return host === bare || host.endsWith(`.${bare}`);
      });
    if (!originOk) {
      logBrowserEvent('BROWSER_EVENT', {
        action: 'FRAME_BLOCKED',
        reason: 'frame origin is not allowed',
        origin,
      });
      throw new UrlBlockedError('Frame origin is not allowed', frameUrl);
    }
    return safeUrl;
  }

  async evaluate<T>(pageFunction: string | ((arg?: unknown) => T)): Promise<T> {
    this.assertUsable();
    return this.pwFrame.evaluate(pageFunction);
  }

  async click(selector: string): Promise<void> {
    this.assertUsable();
    await this.pwFrame.click(selector, { timeout: this.config.actionTimeoutMs });
    logBrowserEvent('ACTION_PERFORMED', { action: 'click', selector, inFrame: true });
  }

  async waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
    this.assertUsable();
    await this.pwFrame.waitForSelector(selector, {
      timeout: timeoutMs ?? this.config.actionTimeoutMs,
    });
  }

  async setInputFiles(selector: string, files: string[]): Promise<void> {
    this.assertUsable();
    await this.pwFrame.setInputFiles(selector, files, {
      timeout: this.config.actionTimeoutMs,
    });
    logBrowserEvent('ACTION_PERFORMED', {
      action: 'setInputFiles',
      selector,
      fileCount: files.length,
      inFrame: true,
    });
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
