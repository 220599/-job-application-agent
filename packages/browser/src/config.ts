import os from 'os';
import path from 'path';

/**
 * Browser automation configuration (Phase 6).
 *
 * Everything is environment-driven with sensible development defaults.
 * Nothing is hardcoded to a specific user, site, or storage backend.
 *
 *  PLAYWRIGHT_HEADLESS             - "false" to run headed for debugging (default: true)
 *  PLAYWRIGHT_NAVIGATION_TIMEOUT   - page navigation timeout ms (default: 30000)
 *  PLAYWRIGHT_ACTION_TIMEOUT       - element/action timeout ms (default: 15000)
 *  PLAYWRIGHT_SCREENSHOT_DIR       - where screenshots are stored (default: <tmpdir>/jaa-screenshots)
 *  PLAYWRIGHT_ALLOW_PRIVATE_URLS   - "true" allows localhost/private IPs. OFF by default;
 *                                    only for local tests/dev fixtures. Never enable in production.
 *  PLAYWRIGHT_SLOW_MO              - ms delay between actions (debugging aid, default: 0)
 */

function boolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function numEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

export interface BrowserConfig {
  headless: boolean;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  screenshotDir: string;
  /** SSRF guard: allow localhost/private-network URLs. Tests/dev only. */
  allowPrivateUrls: boolean;
  slowMoMs: number;
}

export function getBrowserConfig(overrides?: Partial<BrowserConfig>): BrowserConfig {
  return {
    headless: boolEnv('PLAYWRIGHT_HEADLESS', true),
    navigationTimeoutMs: numEnv('PLAYWRIGHT_NAVIGATION_TIMEOUT', 30_000),
    actionTimeoutMs: numEnv('PLAYWRIGHT_ACTION_TIMEOUT', 15_000),
    screenshotDir:
      process.env.PLAYWRIGHT_SCREENSHOT_DIR ?? path.join(os.tmpdir(), 'jaa-screenshots'),
    allowPrivateUrls: boolEnv('PLAYWRIGHT_ALLOW_PRIVATE_URLS', false),
    slowMoMs: numEnv('PLAYWRIGHT_SLOW_MO', 0),
    ...overrides,
  };
}
