import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  launchBrowser,
  closeBrowser,
  validatePublicHttpUrl,
  UrlBlockedError,
  InvalidUrlError,
} from '../src';
import { startMockAtsServer, type MockAtsServer } from './fixtures/mock-ats-server';

/**
 * Phase 6 browser foundation tests.
 * All data is fake. The mock ATS runs locally on 127.0.0.1, which requires
 * a test-only browser launched with allowPrivateUrls - production defaults
 * block loopback/private URLs entirely.
 */

let mock: MockAtsServer;
let screenshotDir: string;

beforeAll(async () => {
  mock = await startMockAtsServer();
  screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jaa-browser-test-'));
});

afterAll(async () => {
  await closeBrowser();
  await mock.close();
});

describe('URL validation (SSRF protection)', () => {
  it('6. rejects dangerous URLs: file://, javascript:, data:, private IPs, credentials', () => {
    const dangerous = [
      'file:///C:/Windows/system32/config',
      'javascript:alert(1)',
      'data:text/html,<h1>xss</h1>',
      'ftp://example.com/file',
      'http://localhost:4001/api',
      'http://127.0.0.1/anything',
      'http://[::1]/anything',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://172.16.0.1/',
      'http://metadata.google.internal/computeMetadata',
      'https://user:pass@example.com/',
    ];
    for (const url of dangerous) {
      const result = validatePublicHttpUrl(url);
      expect(result.valid, `expected ${url} to be rejected`).toBe(false);
    }
  });

  it('accepts legitimate public URLs', () => {
    for (const url of [
      'https://job-boards.greenhouse.io/karbon/jobs/6208899004',
      'http://example.com/path?query=1',
    ]) {
      expect(validatePublicHttpUrl(url).valid).toBe(true);
    }
  });

  it('allowPrivateUrls exists for local fixtures but still blocks dangerous protocols', () => {
    expect(validatePublicHttpUrl('http://127.0.0.1:9999/', { allowPrivate: true }).valid).toBe(true);
    expect(validatePublicHttpUrl('file:///tmp/x', { allowPrivate: true }).valid).toBe(false);
    expect(validatePublicHttpUrl('javascript:void(0)', { allowPrivate: true }).valid).toBe(false);
  });
});

describe('browser lifecycle', () => {
  it('1. launches a browser (reused singleton)', async () => {
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    expect(browser.isOpen()).toBe(true);
    expect(browser.version()).toMatch(/^\d+/);
    const again = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    expect(again).toBe(browser); // same instance - no relaunch per operation
  });

  it('2. creates an isolated browser context', async () => {
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext();
    expect(context).toBeDefined();
    const page = await context.createPage();
    expect(page.getCurrentUrl()).toBe('about:blank');
    await context.close();
  });

  it('12. cleans up browser and context resources', async () => {
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir, headless: true });
    const context = await browser.createContext();
    await context.close();
    // closeBrowser is also called in afterAll; verify isOpen reflects state
    expect(browser.isOpen()).toBe(true);
    await closeBrowser();
    expect(browser.isOpen()).toBe(false);
  });
});

describe('navigation & inspection', () => {
  it('3. navigates to the local mock page', async () => {
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext();
    const page = await context.createPage();
    const result = await page.navigate(mock.url);
    expect(result.status).toBe(200);
    expect(result.redirected).toBe(false);
    expect(result.url.startsWith('http://127.0.0.1:')).toBe(true);
    await context.close();
  });

  it('4. reads the page title', async () => {
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext();
    const page = await context.createPage();
    await page.navigate(mock.url);
    expect(await page.getTitle()).toBe('Mock ATS - Job Application');
    await context.close();
  });

  it('detects HTTP errors and rejects navigation timeouts', async () => {
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext();
    const page = await context.createPage();
    await page.navigate(mock.url);

    // 404 is detectable -> HttpNavigationError
    const { HttpNavigationError } = await import('../src');
    await expect(page.navigate(`${mock.url}/definitely-missing`)).rejects.toThrow(HttpNavigationError);

    // Unroutable host -> NavigationFailedError (connection refused/DNS)
    const { NavigationFailedError } = await import('../src');
    await expect(page.navigate('http://no-such-host.invalid/')).rejects.toThrow(NavigationFailedError);

    await context.close();
  });
});

describe('mock ATS application flow (fake data only)', () => {
  it('7-11. loads page, fills fields, uploads fake resume, submits, verifies success', async () => {
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext();
    const page = await context.createPage();

    // 7. mock page loads
    await page.navigate(mock.url);

    // 8. form fields are detectable
    await page.waitForPage({ selector: '#app-form' });
    await page.waitForSelector('#name');
    await page.waitForSelector('#email');
    await page.waitForSelector('#phone');
    await page.waitForSelector('#resume');
    await page.waitForSelector('#submit-btn');

    // 9. enter fake test data
    await page.fill('#name', 'Test Candidate');
    await page.fill('#email', 'test.candidate@example.com');
    await page.fill('#phone', '(555) 010-0000');

    // 10. upload the fake resume fixture through the file input
    const fakeResumePath = path.join(__dirname, 'fixtures', 'fake-resume.txt');
    await page.setInputFiles('#resume', [fakeResumePath]);

    // 11. submit and verify the mock page reports success
    await page.click('#submit-btn');
    await page.waitForPage({ selector: '#status:has-text("Application submitted successfully")' });
    const status = await page.evaluate(
      () => document.getElementById('status')?.textContent ?? null
    );
    expect(status).toBe('Application submitted successfully');

    // The mock server actually received the fake values
    expect(mock.submissions.length).toBeGreaterThan(0);
    const last = mock.submissions[mock.submissions.length - 1];
    expect(last.name).toBe('Test Candidate');
    expect(last.email).toBe('test.candidate@example.com');
    expect(last.resumeFileName).toBe('fake-resume.txt');

    // 5. screenshot works
    const shotPath = await page.screenshot('mock-ats-submitted');
    const stat = await fs.stat(shotPath);
    expect(stat.size).toBeGreaterThan(0);

    await context.close();
  });
});

describe('session isolation', () => {
  it('13. contexts do not share storage state', async () => {
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const contextA = await browser.createContext();
    const contextB = await browser.createContext();

    const pageA = await contextA.createPage();
    await pageA.navigate(mock.url);
    await pageA.evaluate(() => localStorage.setItem('isolation-probe', 'context-A'));

    const pageB = await contextB.createPage();
    await pageB.navigate(mock.url);
    const probe = await pageB.evaluate(() => localStorage.getItem('isolation-probe'));
    expect(probe).toBeNull(); // context B must not see context A's data

    await contextA.close();
    await contextB.close();
  });
});

describe('SSRF enforcement in navigation (default config)', () => {
  it('blocks localhost/private URLs even if requested through navigate()', async () => {
    // Use the shared browser (launched for fixtures) but create a context
    // WITHOUT allowPrivateUrls - the production default for real runs.
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: false });
    const page = await context.createPage();

    // The mock server runs on 127.0.0.1 - must be refused by default.
    await expect(page.navigate(mock.url)).rejects.toThrow(UrlBlockedError);
    await expect(page.navigate('http://localhost/')).rejects.toThrow(UrlBlockedError);
    await expect(page.navigate('not a url at all')).rejects.toThrow(InvalidUrlError);

    await context.close();
  });
});
