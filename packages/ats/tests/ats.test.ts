import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  AtsRegistry,
  createDefaultAtsRegistry,
  AtsError,
  type AtsAdapter,
  type AtsAdapterContext,
} from '../src';
import { MockAtsAdapter, MOCK_ATS_PROVIDER, isMockAtsUrl } from './fixtures/mock-adapter';
import { startMockAtsServer, type MockAtsServer } from './fixtures/mock-ats-server';

let mock: MockAtsServer;
let screenshotDir: string;

beforeAll(async () => {
  mock = await startMockAtsServer();
  screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jaa-ats-test-'));
});

afterAll(async () => {
  const { closeBrowser } = await import('@jaa/browser');
  await closeBrowser();
  await mock.close();
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('AtsRegistry', () => {
  it('registers and retrieves an adapter by provider (case-insensitive)', () => {
    const registry = createDefaultAtsRegistry();
    const adapter = new MockAtsAdapter();
    registry.register(adapter);
    expect(registry.get('MOCK')).toBe(adapter);
    expect(registry.get('mock')).toBe(adapter);
    expect(registry.has('MOCK')).toBe(true);
    expect(registry.list()).toEqual(['MOCK']);
  });

  it('rejects duplicate providers', () => {
    const registry = createDefaultAtsRegistry();
    registry.register(new MockAtsAdapter());
    expect(() => registry.register(new MockAtsAdapter())).toThrowError(AtsError);
    try {
      registry.register(new MockAtsAdapter());
    } catch (err) {
      expect((err as AtsError).code).toBe('DUPLICATE_PROVIDER');
    }
  });

  it('throws a clear error for unknown providers', () => {
    const registry = createDefaultAtsRegistry();
    expect(() => registry.get('GREENHOUSE')).toThrowError(AtsError);
    try {
      registry.get('GREENHOUSE');
    } catch (err) {
      expect((err as AtsError).code).toBe('ADAPTER_NOT_FOUND');
    }
  });

  it('finds an adapter by URL deterministically and returns null when none matches', () => {
    const registry = createDefaultAtsRegistry();
    const unrelatedAdapter: AtsAdapter = {
      provider: 'UNRELATED',
      name: 'Unrelated',
      canHandle: (url) => url.includes('unrelated.example.com'),
      inspectApplication: async () => {
        throw new Error('not used');
      },
      prepareApplication: async () => {
        throw new Error('not used');
      },
    };
    const mockAdapter = new MockAtsAdapter();
    registry.register(unrelatedAdapter);
    registry.register(mockAdapter);

    // Deterministic: first registration that claims the URL wins.
    expect(registry.findForUrl(mock.url)).toBe(mockAdapter);
    expect(registry.findForUrl('https://unrelated.example.com/job/1')).toBe(unrelatedAdapter);
    expect(registry.findForUrl('https://unknown.example.com/job/1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

describe('MockAtsAdapter.canHandle', () => {
  const adapter = new MockAtsAdapter();

  it('recognizes the deterministic mock URL pattern', () => {
    expect(adapter.canHandle(mock.url)).toBe(true);
    expect(adapter.canHandle('http://localhost:59999/')).toBe(true);
    expect(isMockAtsUrl(mock.url)).toBe(true);
  });

  it('rejects unrelated URLs', () => {
    expect(adapter.canHandle('https://job-boards.greenhouse.io/karbon/jobs/1')).toBe(false);
    expect(adapter.canHandle('https://jobs.lever.co/acme/123')).toBe(false);
    expect(adapter.canHandle('not a url')).toBe(false);
  });
});

describe('MockAtsAdapter.inspectApplication', () => {
  it('inspects the mock application page and returns structured fields', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();
    const adapter = new MockAtsAdapter();
    const inspection = await adapter.inspectApplication({ url: mock.url, page, context });

    expect(inspection.provider).toBe('MOCK');
    expect(inspection.pageTitle).toBe('Mock ATS - Job Application');
    expect(inspection.isApplicationForm).toBe(true);
    expect(inspection.blockers).toEqual([]);

    // 5 fields: name, email, phone, role (select), resume (file)
    expect(inspection.fields).toHaveLength(5);
    const byLabel = new Map(inspection.fields.map((f) => [f.normalizedLabel, f]));
    expect(byLabel.get('full_name')?.type).toBe('TEXT');
    expect(byLabel.get('email')?.type).toBe('EMAIL');
    expect(byLabel.get('phone')?.type).toBe('PHONE');
    expect(byLabel.get('resume')?.type).toBe('FILE');

    // required detection
    expect(byLabel.get('full_name')?.required).toBe(true);
    expect(byLabel.get('email')?.required).toBe(true);
    expect(byLabel.get('phone')?.required).toBe(false);

    // options detection (select)
    const role = byLabel.get('role');
    expect(role?.type).toBe('SELECT');
    expect(role?.options?.map((o) => o.value)).toEqual(['', 'engineer', 'analyst']);

    // locators map to css selectors
    expect(byLabel.get('email')?.locator?.cssSelector).toBe('#email');

    await context.close();
  });

  it('reports PAGE_NOT_RECOGNIZED-style results for a non-form page', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();
    const adapter = new MockAtsAdapter();
    const inspection = await adapter.inspectApplication({ url: `${mock.url}/no-form`, page, context });
    expect(inspection.isApplicationForm).toBe(false);
    expect(inspection.fields).toEqual([]);
    expect(inspection.warnings.length).toBeGreaterThan(0);
    await context.close();
  });

  it('maps browser security blocks to ATS errors (cannot bypass URL validation)', async () => {
    // Default browser (no allowPrivateUrls) refuses loopback URLs even for
    // the mock adapter - the adapter cannot bypass browser validation.
    const { launchBrowser } = await import('@jaa/browser');
    const strictBrowser = await launchBrowser({ allowPrivateUrls: false, screenshotDir });
    const strictContext = await strictBrowser.createContext({ allowPrivateUrls: false });
    const page = await strictContext.createPage();

    const adapter = new MockAtsAdapter();
    await expect(
      adapter.inspectApplication({ url: mock.url, page, context: strictContext })
    ).rejects.toThrowError(AtsError);

    try {
      await adapter.inspectApplication({ url: mock.url, page, context: strictContext });
    } catch (err) {
      expect((err as AtsError).code).toBe('BLOCKED_BY_SECURITY_POLICY');
    }

    // file:// URLs are invalid regardless of allowPrivateUrls
    await expect(
      adapter.inspectApplication({ url: 'file:///etc/passwd', page, context: strictContext })
    ).rejects.toThrowError(AtsError);

    await strictContext.close();
  });
});

describe('MockAtsAdapter.prepareApplication', () => {
  it('returns NEEDS_REVIEW for a recognized form without submitting anything', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();

    const adapter = new MockAtsAdapter();
    const preparation = await adapter.prepareApplication({ url: mock.url, page, context });

    expect(preparation.provider).toBe('MOCK');
    expect(preparation.status).toBe('NEEDS_REVIEW'); // fields not mapped yet (Phase 9)
    expect(preparation.inspection?.isApplicationForm).toBe(true);
    expect(preparation.errors).toEqual([]);
    expect(preparation.warnings.join(' ')).toMatch(/not mapped yet/i);

    // Nothing was submitted to the mock server
    expect(mock.submissions).toHaveLength(0);

    await context.close();
  });

  it('returns BLOCKED for a page that is not an application form', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();

    const adapter = new MockAtsAdapter();
    const preparation = await adapter.prepareApplication({ url: `${mock.url}/no-form`, page, context });
    expect(preparation.status).toBe('BLOCKED');
    expect(preparation.errors.join(' ')).toMatch(/does not appear to be an application form/i);

    await context.close();
  });

  it('returns FAILED (not thrown) when navigation fails', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: false, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: false });
    const page = await context.createPage();

    const adapter = new MockAtsAdapter();
    const preparation = await adapter.prepareApplication({ url: mock.url, page, context });
    expect(preparation.status).toBe('FAILED');
    expect(preparation.errors[0]).toContain('BLOCKED_BY_SECURITY_POLICY');

    await context.close();
  });
});

// ---------------------------------------------------------------------------
// Integration guards
// ---------------------------------------------------------------------------

describe('architecture guards', () => {
  it('no package outside @jaa/browser imports Playwright', async () => {
    const packagesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const dirsToScan = [
      path.join(packagesRoot, 'ats', 'src'),
      path.join(packagesRoot, 'core', 'src'),
      path.join(packagesRoot, 'greenhouse', 'src'),
    ];
    const forbidden = /from\s+['"](playwright|@playwright\/|playwright-core)['"]|require\(['"](playwright|@playwright\/|playwright-core)['"]\)/i;

    for (const dir of dirsToScan) {
      const files = await fs.readdir(dir, { recursive: true });
      for (const file of files) {
        if (!file.endsWith('.ts')) continue;
        const content = await fs.readFile(path.join(dir, file as string), 'utf-8');
        expect(forbidden.test(content), `${dir}/${file} must not import Playwright`).toBe(false);
      }
    }
  });

  it('the generic ats package has no Greenhouse dependency', async () => {
    // tests dir -> ats package root
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['@jaa/greenhouse']).toBeUndefined();
  });
});
