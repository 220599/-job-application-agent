import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { createDefaultAtsRegistry, AtsError, type AtsAdapter } from '@jaa/ats';

import {
  LeverAtsAdapter,
  LEVER_PROVIDER,
  isLeverApplicationUrl,
  registerLeverAdapter,
  classifyLeverField,
} from '../src';
import { startMockLeverServer, type MockLeverServer } from './fixtures/mock-lever-server';

let mock: MockLeverServer;
let screenshotDir: string;

/** Adapter wired for the local fixture host (explicit, test-only). */
function fixtureAdapter(): LeverAtsAdapter {
  return new LeverAtsAdapter({ extraBoardHosts: ['127.0.0.1'] });
}

async function inspectPath(route: string) {
  const { launchBrowser } = await import('@jaa/browser');
  const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
  const context = await browser.createContext({ allowPrivateUrls: true });
  const page = await context.createPage();
  const adapter = fixtureAdapter();
  const inspection = await adapter.inspectApplication({ url: `${mock.url}${route}`, page, context });
  await context.close();
  return inspection;
}

beforeAll(async () => {
  mock = await startMockLeverServer();
  screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jaa-lever-test-'));
});

afterAll(async () => {
  const { closeBrowser } = await import('@jaa/browser');
  await closeBrowser();
  await mock.close();
});

// ---------------------------------------------------------------------------
// URL recognition
// ---------------------------------------------------------------------------

describe('Lever URL recognition', () => {
  const adapter = new LeverAtsAdapter();

  it('recognizes standard Lever application URLs', () => {
    expect(adapter.canHandle('https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c')).toBe(true);
    expect(
      adapter.canHandle('https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c/apply')
    ).toBe(true);
    expect(
      adapter.canHandle('https://jobs.lever.co/acme/senior-engineer-123456?lever=true')
    ).toBe(true);
  });

  it('rejects unrelated and non-application URLs', () => {
    expect(adapter.canHandle('https://jobs.lever.co/palantir')).toBe(false); // board index
    expect(adapter.canHandle('https://jobs.lever.co/')).toBe(false);
    expect(adapter.canHandle('https://jobs.lever.co/a/b/extra')).toBe(false);
    expect(adapter.canHandle('https://jobs.lever.co/a/b/apply/more')).toBe(false);
    expect(adapter.canHandle('https://app.lever.co/application/789012')).toBe(false); // dashboard
    expect(adapter.canHandle('https://lever.co/acme/123')).toBe(false);
    expect(adapter.canHandle('https://job-boards.greenhouse.io/acme/jobs/1')).toBe(false);
    expect(adapter.canHandle('https://boards.greenhouse.io/acme/jobs/1')).toBe(false);
    expect(adapter.canHandle('https://example.com/jobs/1')).toBe(false);
    expect(adapter.canHandle('not a url')).toBe(false);
  });

  it('rejects non-web and credential-bearing URLs', () => {
    expect(adapter.canHandle('file:///etc/passwd')).toBe(false);
    expect(adapter.canHandle('javascript:alert(1)')).toBe(false);
    expect(adapter.canHandle('https://user:pass@jobs.lever.co/acme/123')).toBe(false);
  });

  it('is case-insensitive where appropriate', () => {
    expect(adapter.canHandle('https://JOBS.LEVER.CO/Company/Posting-Id')).toBe(true);
    expect(adapter.canHandle('https://Jobs.Lever.CO/acme/123/APPLY')).toBe(true);
    expect(isLeverApplicationUrl('HTTPS://JOBS.LEVER.CO/ACME/123')).toBe(true);
  });

  it('is deterministic and performs no network requests', () => {
    const url = 'https://jobs.lever.co/acme/123';
    for (let i = 0; i < 5; i += 1) {
      expect(adapter.canHandle(url)).toBe(true);
    }
  });

  it('supports custom careers hosts without hardcoding employers', () => {
    const custom = new LeverAtsAdapter({ extraBoardHosts: ['careers.acme.example'] });
    expect(custom.canHandle('https://careers.acme.example/apply/123')).toBe(true);
    expect(custom.canHandle('https://careers.other.example/apply/123')).toBe(false);
    expect(adapter.canHandle('https://careers.acme.example/apply/123')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

describe('Lever registry integration', () => {
  it('registers through the Phase 7 registry without provider knowledge in it', () => {
    const registry = createDefaultAtsRegistry();
    const adapter = registerLeverAdapter(registry);
    expect(registry.get('LEVER')).toBe(adapter);
    expect(registry.get('lever')).toBe(adapter);
    expect(registry.has(LEVER_PROVIDER)).toBe(true);
    expect(registry.list()).toEqual(['LEVER']);
  });

  it('resolves the Lever adapter by URL and rejects foreign URLs', () => {
    const registry = createDefaultAtsRegistry();
    const adapter = registerLeverAdapter(registry);
    const unrelated: AtsAdapter = {
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
    registry.register(unrelated);

    expect(registry.findForUrl('https://jobs.lever.co/acme/abc-123')).toBe(adapter);
    expect(registry.findForUrl('https://jobs.lever.co/acme/abc-123/apply')).toBe(adapter);
    expect(registry.findForUrl('https://job-boards.greenhouse.io/acme/jobs/1')).toBeNull();
    expect(registry.findForUrl('https://unrelated.example.com/job/1')).toBe(unrelated);
  });

  it('coexists with other providers in registration order', () => {
    const registry = createDefaultAtsRegistry();
    const lever = registerLeverAdapter(registry);
    const other: AtsAdapter = {
      provider: 'OTHER',
      name: 'Other',
      canHandle: () => true,
      inspectApplication: async () => {
        throw new Error('not used');
      },
      prepareApplication: async () => {
        throw new Error('not used');
      },
    };
    registry.register(other);
    // Deterministic: first registered adapter that claims the URL wins.
    expect(registry.findForUrl('https://jobs.lever.co/acme/123')).toBe(lever);
  });

  it('rejects duplicate registration', () => {
    const registry = createDefaultAtsRegistry();
    registerLeverAdapter(registry);
    expect(() => registerLeverAdapter(registry)).toThrowError(AtsError);
  });
});

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

describe('Lever inspection', () => {
  it('inspects the application form and returns typed provider-independent fields', async () => {
    const inspection = await inspectPath('/');

    expect(inspection.provider).toBe('LEVER');
    expect(inspection.pageTitle).toBe('Administrative Business Partner - TestCo | Lever');
    expect(inspection.isApplicationForm).toBe(true);
    expect(inspection.blockers.join(' ')).not.toMatch(/another ATS platform/i);
    expect(inspection.fields).toHaveLength(17);

    const byId = new Map(inspection.fields.map((f) => [f.externalFieldId, f]));

    // Field types (including semantic refinement of plain text inputs)
    expect(byId.get('name')?.type).toBe('TEXT');
    expect(byId.get('email')?.type).toBe('EMAIL');
    expect(byId.get('phone')?.type).toBe('PHONE'); // type="text" refined by semantic class
    expect(byId.get('location-input')?.type).toBe('TEXT');
    expect(byId.get('cards[3da58b41-0000-0000-0000-000000000003][field0]')?.type).toBe('SELECT');
    expect(byId.get('cards[1c719ca9-0000-0000-0000-000000000002][field0]')?.type).toBe('RADIO');
    expect(byId.get('cards[69a985a0-0000-0000-0000-000000000001][field0]')?.type).toBe('CHECKBOX');
    expect(byId.get('cards[ce72d538-0000-0000-0000-000000000004][field0]')?.type).toBe('TEXTAREA');
    expect(byId.get('additional-information')?.type).toBe('TEXTAREA');
    expect(byId.get('resume-upload-input')?.type).toBe('FILE');
    expect(byId.get('consent[marketing]')?.type).toBe('CHECKBOX');

    // Labels are normalized (required markers stripped)
    expect(byId.get('name')?.label).toBe('Full name');
    expect(byId.get('name')?.normalizedLabel).toBe('full_name');
    expect(byId.get('resume-upload-input')?.label).toBe('Resume/CV');
    expect(byId.get('cards[69a985a0-0000-0000-0000-000000000001][field0]')?.label).toBe(
      'Language Skill(s) (Check all that apply)'
    );
  });

  it('detects required fields and optional fields correctly', async () => {
    const inspection = await inspectPath('/');
    const byId = new Map(inspection.fields.map((f) => [f.externalFieldId, f]));

    expect(byId.get('name')?.required).toBe(true);
    expect(byId.get('email')?.required).toBe(true);
    expect(byId.get('location-input')?.required).toBe(true);
    expect(byId.get('resume-upload-input')?.required).toBe(true);
    expect(byId.get('cards[1c719ca9-0000-0000-0000-000000000002][field0]')?.required).toBe(true);
    expect(byId.get('cards[1c719ca9-0000-0000-0000-000000000002][field1]')?.required).toBe(true);
    expect(byId.get('cards[69a985a0-0000-0000-0000-000000000001][field0]')?.required).toBe(true);
    expect(byId.get('cards[3da58b41-0000-0000-0000-000000000003][field0]')?.required).toBe(true);

    expect(byId.get('phone')?.required).toBe(false);
    expect(byId.get('org')?.required).toBe(false);
    expect(byId.get('urls[LinkedIn]')?.required).toBe(false);
    expect(byId.get('consent[marketing]')?.required).toBe(false);
    expect(byId.get('additional-information')?.required).toBe(false);
  });

  it('detects first/last name, contact, links, work authorization and sponsorship', async () => {
    const inspection = await inspectPath('/');
    const byId = new Map(inspection.fields.map((f) => [f.externalFieldId, f]));
    const semantic = (id: string) => byId.get(id)?.locator?.attributes?.semantic;

    expect(semantic('name')).toBe('full_name');
    expect(semantic('email')).toBe('email');
    expect(semantic('phone')).toBe('phone');
    expect(semantic('location-input')).toBe('location');
    expect(semantic('resume-upload-input')).toBe('resume');
    expect(semantic('urls[LinkedIn]')).toBe('linkedin');
    expect(semantic('urls[GitHub]')).toBe('github');
    expect(semantic('urls[Portfolio]')).toBe('portfolio');
    expect(semantic('cards[1c719ca9-0000-0000-0000-000000000002][field0]')).toBe('work_authorization');
    expect(semantic('cards[1c719ca9-0000-0000-0000-000000000002][field1]')).toBe('sponsorship');
  });

  it('detects the resume upload', async () => {
    const inspection = await inspectPath('/');
    const resume = inspection.fields.find((f) => f.externalFieldId === 'resume-upload-input');
    expect(resume?.type).toBe('FILE');
    expect(resume?.required).toBe(true);
    expect(resume?.label).toBe('Resume/CV');
    expect(resume?.locator?.attributes?.name).toBe('resume');
    expect(resume?.locator?.attributes?.['data-qa']).toBe('input-resume');
    expect(resume?.locator?.attributes?.semantic).toBe('resume');
    expect(resume?.locator?.cssSelector).toBe('#resume-upload-input');
  });

  it('captures select and radio options', async () => {
    const inspection = await inspectPath('/');
    const byId = new Map(inspection.fields.map((f) => [f.externalFieldId, f]));

    const select = byId.get('cards[3da58b41-0000-0000-0000-000000000003][field0]');
    expect(select?.options).toEqual([
      { value: '', label: 'Select...' },
      { value: 'Aalborg University', label: 'Aalborg University' },
      { value: 'Aalto University', label: 'Aalto University' },
      { value: 'Other (School Not Listed)', label: 'Other (School Not Listed)' },
    ]);

    const radio = byId.get('cards[1c719ca9-0000-0000-0000-000000000002][field0]');
    expect(radio?.type).toBe('RADIO');
    expect(radio?.options).toEqual([
      { value: 'Yes', label: 'Yes' },
      { value: 'No', label: 'No' },
    ]);

    const checkbox = byId.get('cards[69a985a0-0000-0000-0000-000000000001][field0]');
    expect(checkbox?.type).toBe('CHECKBOX');
    expect(checkbox?.options).toEqual([
      { value: 'English (ENG)', label: 'English (ENG)' },
      { value: 'Spanish (SPA)', label: 'Spanish (SPA)' },
      { value: 'French (FRA)', label: 'French (FRA)' },
    ]);
  });

  it('captures stable identifiers and locators', async () => {
    const inspection = await inspectPath('/');
    const radio = inspection.fields.find(
      (f) => f.externalFieldId === 'cards[1c719ca9-0000-0000-0000-000000000002][field0]'
    );
    expect(radio).toBeDefined();
    expect(radio?.locator?.cssSelector).toBe('[name="cards[1c719ca9-0000-0000-0000-000000000002][field0]"]');
    expect(radio?.locator?.attributes?.name).toBe('cards[1c719ca9-0000-0000-0000-000000000002][field0]');

    const email = inspection.fields.find((f) => f.externalFieldId === 'email');
    expect(email?.locator?.cssSelector).toBe('[name="email"]');
    expect(email?.locator?.attributes?.['data-qa']).toBe('email-input');
  });

  it('captures sections from the Lever card structure', async () => {
    const inspection = await inspectPath('/');
    const byId = new Map(inspection.fields.map((f) => [f.externalFieldId, f]));

    expect(byId.get('name')?.section).toBe('Submit your application');
    expect(byId.get('urls[LinkedIn]')?.section).toBe('Links');
    expect(byId.get('cards[69a985a0-0000-0000-0000-000000000001][field0]')?.section).toBe(
      'Supplementary Questions'
    );
    expect(byId.get('cards[1c719ca9-0000-0000-0000-000000000002][field0]')?.section).toBe(
      'Work Authorization'
    );
    expect(byId.get('cards[3da58b41-0000-0000-0000-000000000003][field0]')?.section).toBe('University');
    expect(byId.get('additional-information')?.section).toBe('Additional information');
  });

  it('reports the CAPTCHA presence without solving or bypassing it', async () => {
    const inspection = await inspectPath('/');
    expect(inspection.warnings.join(' ')).toMatch(/h-captcha CAPTCHA is present/i);
    expect(inspection.warnings.join(' ')).toMatch(/never bypassed/i);
  });
});

// ---------------------------------------------------------------------------
// Non-Lever pages
// ---------------------------------------------------------------------------

describe('non-Lever page handling', () => {
  it('reports isApplicationForm=false for a page without a form', async () => {
    const inspection = await inspectPath('/no-form');
    expect(inspection.isApplicationForm).toBe(false);
    expect(inspection.fields).toEqual([]);
    expect(inspection.warnings.join(' ')).toMatch(/no application form/i);
  });

  it('does not pretend a generic page with an unrelated form is an application', async () => {
    const inspection = await inspectPath('/generic-form');
    expect(inspection.isApplicationForm).toBe(false);
    expect(inspection.fields).toEqual([]);
    expect(inspection.warnings.join(' ')).toMatch(/does not appear to be a Lever application form/i);
  });

  it('refuses a page that carries another ATS platform markup', async () => {
    const inspection = await inspectPath('/foreign');
    expect(inspection.isApplicationForm).toBe(false);
    expect(inspection.fields).toEqual([]);
    expect(inspection.blockers.join(' ')).toMatch(/another ATS platform/i);
  });

  it('throws a structured AtsError when asked to inspect a non-Lever URL', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();
    const adapter = fixtureAdapter();
    await expect(
      adapter.inspectApplication({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', page, context })
    ).rejects.toThrowError(AtsError);
    try {
      await adapter.inspectApplication({ url: 'file:///etc/passwd', page, context });
    } catch (err) {
      expect((err as AtsError).code).toBe('PAGE_NOT_RECOGNIZED');
      expect((err as AtsError).provider).toBe('LEVER');
    }
    await context.close();
  });
});

// ---------------------------------------------------------------------------
// Security & failures
// ---------------------------------------------------------------------------

describe('browser security enforcement', () => {
  it('cannot bypass the browser SSRF policy', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: false });
    const page = await context.createPage();
    const adapter = fixtureAdapter();

    await expect(
      adapter.inspectApplication({ url: mock.url, page, context })
    ).rejects.toThrowError(AtsError);
    try {
      await adapter.inspectApplication({ url: mock.url, page, context });
    } catch (err) {
      expect((err as AtsError).code).toBe('BLOCKED_BY_SECURITY_POLICY');
    }
    await context.close();
  });

  it('never resolves file:// or javascript: URLs', async () => {
    const adapter = fixtureAdapter();
    expect(adapter.canHandle('file:///etc/passwd')).toBe(false);
    expect(adapter.canHandle('javascript:alert(1)')).toBe(false);
    expect(adapter.canHandle('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(adapter.canHandle('http://localhost:8080/jobs/1')).toBe(false);
  });

  it('maps navigation failures to structured errors', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();
    const adapter = fixtureAdapter();

    await expect(
      adapter.inspectApplication({ url: `${mock.url}/missing`, page, context })
    ).rejects.toThrowError(AtsError);
    try {
      await adapter.inspectApplication({ url: `${mock.url}/missing`, page, context });
    } catch (err) {
      expect((err as AtsError).code).toBe('INSPECTION_FAILED');
    }
    await context.close();
  });
});

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

describe('Lever prepareApplication', () => {
  it('returns NEEDS_REVIEW for a recognized form without filling or submitting', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();
    const adapter = fixtureAdapter();

    const preparation = await adapter.prepareApplication({ url: `${mock.url}/`, page, context });
    expect(preparation.provider).toBe('LEVER');
    expect(preparation.status).toBe('NEEDS_REVIEW'); // ready for the later mapping/review stage
    expect(preparation.inspection?.isApplicationForm).toBe(true);
    expect(preparation.errors).toEqual([]);
    expect(preparation.warnings.join(' ')).toMatch(/not mapped to candidate data/i);

    // No visible field was filled and nothing was submitted. (Hidden
    // server-side inputs carry static values from the page itself; for
    // radios/checkboxes the "filled" state is .checked, not .value.)
    const anyValue = await page.evaluate(() => {
      const typed = Array.from(
        document.querySelectorAll(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select'
        )
      ).some((el) => (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value !== '');
      const checked = Array.from(
        document.querySelectorAll('input[type="checkbox"], input[type="radio"]')
      ).some((el) => (el as HTMLInputElement).checked);
      return typed || checked;
    });
    expect(anyValue).toBe(false);
    expect(mock.submissions).toHaveLength(0);

    await context.close();
  });

  it('returns BLOCKED for a page that is not an application form', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();
    const adapter = fixtureAdapter();

    const preparation = await adapter.prepareApplication({
      url: `${mock.url}/no-form`,
      page,
      context,
    });
    expect(preparation.status).toBe('BLOCKED');
    expect(preparation.errors.join(' ')).toMatch(/does not appear to be a Lever application form/i);
    await context.close();
  });

  it('returns FAILED (not thrown) when navigation fails or is blocked', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: false });
    const page = await context.createPage();
    const adapter = fixtureAdapter();

    const preparation = await adapter.prepareApplication({ url: mock.url, page, context });
    expect(preparation.status).toBe('FAILED');
    expect(preparation.errors[0]).toContain('BLOCKED_BY_SECURITY_POLICY');
    await context.close();
  });

  it('never submits an application during preparation', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();
    const adapter = fixtureAdapter();

    await adapter.prepareApplication({ url: `${mock.url}/`, page, context });
    expect(mock.submissions).toHaveLength(0);
    await context.close();
  });
});

// ---------------------------------------------------------------------------
// Architecture guards
// ---------------------------------------------------------------------------

describe('architecture guards', () => {
  it('no package outside @jaa/browser imports Playwright', async () => {
    const packagesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const dirsToScan = [
      path.join(packagesRoot, 'ats', 'src'),
      path.join(packagesRoot, 'core', 'src'),
      path.join(packagesRoot, 'greenhouse', 'src'),
      path.join(packagesRoot, 'lever', 'src'),
      path.join(packagesRoot, 'shared', 'src'),
      path.join(packagesRoot, 'database', 'src'),
      path.join(packagesRoot, 'matching', 'src'),
      path.join(packagesRoot, 'resume', 'src'),
      path.join(packagesRoot, '..', 'apps', 'api', 'src'),
      path.join(packagesRoot, '..', 'apps', 'worker', 'src'),
    ];
    const forbidden =
      /from\s+['"](playwright|@playwright\/|playwright-core)['"]|require\(['"](playwright|@playwright\/|playwright-core)['"]\)/i;

    for (const dir of dirsToScan) {
      let files: string[];
      try {
        files = await fs.readdir(dir, { recursive: true });
      } catch {
        continue; // package layout differences are fine
      }
      for (const file of files) {
        if (!file.endsWith('.ts')) continue;
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        expect(forbidden.test(content), `${dir}/${file} must not import Playwright`).toBe(false);
      }
    }
  });

  it('the lever package does not depend on other providers or on Playwright', async () => {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['playwright']).toBeUndefined();
    expect(deps['@playwright/test']).toBeUndefined();
    expect(deps['@jaa/greenhouse']).toBeUndefined();
    expect(deps['@jaa/database']).toBeUndefined();
  });

  it('the generic ats package has no provider dependencies', async () => {
    const pkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'ats',
      'package.json'
    );
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['@jaa/greenhouse']).toBeUndefined();
    expect(deps['@jaa/lever']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Classification unit checks
// ---------------------------------------------------------------------------

describe('classifyLeverField', () => {
  it('classifies common application fields deterministically', () => {
    expect(classifyLeverField('Full name', {})).toBe('full_name');
    expect(classifyLeverField('First Name', {})).toBe('first_name');
    expect(classifyLeverField('Email', {})).toBe('email');
    expect(classifyLeverField('Phone', {})).toBe('phone');
    expect(classifyLeverField('Current location', {})).toBe('location');
    expect(classifyLeverField('LinkedIn URL', { name: 'urls[LinkedIn]' })).toBe('linkedin');
    expect(classifyLeverField('GitHub URL', { name: 'urls[GitHub]' })).toBe('github');
    expect(classifyLeverField('Portfolio URL', { name: 'urls[Portfolio]' })).toBe('portfolio');
    expect(
      classifyLeverField('Are you legally authorized to work in the country for which you are applying?', {})
    ).toBe('work_authorization');
    expect(
      classifyLeverField('Will you now or in the future require sponsorship for employment visa status?', {})
    ).toBe('sponsorship');
    expect(classifyLeverField('Resume/CV', { inputType: 'file' })).toBe('resume');
    expect(classifyLeverField('Cover Letter', { inputType: 'file' })).toBe('cover_letter');
    expect(classifyLeverField('Tell us about yourself', {})).toBeNull();
  });
});
