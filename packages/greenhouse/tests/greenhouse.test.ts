import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { createDefaultAtsRegistry, AtsError, type AtsAdapter } from '@jaa/ats';

import {
  GreenhouseAtsAdapter,
  GREENHOUSE_PROVIDER,
  isGreenhouseApplicationUrl,
  registerGreenhouseAdapter,
  classifyGreenhouseField,
} from '../src';
import {
  startMockGreenhouseServer,
  type MockGreenhouseServer,
} from './fixtures/mock-greenhouse-server';

let mock: MockGreenhouseServer;
let screenshotDir: string;

/** Adapter wired for the local fixture host (explicit, test-only). */
function fixtureAdapter(): GreenhouseAtsAdapter {
  return new GreenhouseAtsAdapter({ extraBoardHosts: ['127.0.0.1'] });
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
  mock = await startMockGreenhouseServer();
  screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jaa-greenhouse-test-'));
});

afterAll(async () => {
  const { closeBrowser } = await import('@jaa/browser');
  await closeBrowser();
  await mock.close();
});

// ---------------------------------------------------------------------------
// URL recognition
// ---------------------------------------------------------------------------

describe('Greenhouse URL recognition', () => {
  const adapter = new GreenhouseAtsAdapter();

  it('recognizes standard Greenhouse application URLs', () => {
    expect(adapter.canHandle('https://boards.greenhouse.io/taskrabbit/jobs/8234605')).toBe(true);
    expect(adapter.canHandle('https://job-boards.greenhouse.io/taskrabbit/jobs/8234605')).toBe(true);
    expect(
      adapter.canHandle('https://job-boards.greenhouse.io/taskrabbit/jobs/8234605?gh_src=abc123')
    ).toBe(true);
    expect(adapter.canHandle('https://boards.greenhouse.io/embed/job_app?for=acme&token=xyz')).toBe(
      true
    );
    // Regional board variants are structural, not employer specific.
    expect(adapter.canHandle('https://boards.eu.greenhouse.io/acme/jobs/99')).toBe(true);
  });

  it('rejects unrelated and non-application URLs', () => {
    expect(adapter.canHandle('https://jobs.lever.co/acme/12345')).toBe(false);
    expect(adapter.canHandle('https://app.lever.co/application/1')).toBe(false);
    expect(adapter.canHandle('https://boards.greenhouse.io/acme')).toBe(false); // board index
    expect(adapter.canHandle('https://boards.greenhouse.io/acme/jobs')).toBe(false); // no job id
    expect(adapter.canHandle('https://boards-api.greenhouse.io/v1/boards/acme')).toBe(false); // API host
    expect(adapter.canHandle('https://api.greenhouse.io/v1/jobs')).toBe(false);
    expect(adapter.canHandle('https://example.com/jobs/1')).toBe(false);
    expect(adapter.canHandle('not a url')).toBe(false);
  });

  it('rejects non-web and credential-bearing URLs', () => {
    expect(adapter.canHandle('file:///etc/passwd')).toBe(false);
    expect(adapter.canHandle('javascript:alert(1)')).toBe(false);
    expect(
      adapter.canHandle('https://user:pass@boards.greenhouse.io/acme/jobs/1')
    ).toBe(false);
  });

  it('is case-insensitive where appropriate', () => {
    const upper = new GreenhouseAtsAdapter();
    expect(upper.canHandle('https://BOARDS.Greenhouse.IO/acme/jobs/1')).toBe(true);
    expect(upper.canHandle('https://Job-Boards.Greenhouse.IO/Acme/Jobs/1')).toBe(true);
    expect(isGreenhouseApplicationUrl('HTTPS://BOARDS.GREENHOUSE.IO/ACME/JOBS/1')).toBe(true);
  });

  it('is deterministic and performs no network requests', () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/1';
    for (let i = 0; i < 5; i += 1) {
      expect(adapter.canHandle(url)).toBe(true);
    }
  });

  it('supports custom board hosts without hardcoding employers', () => {
    const custom = new GreenhouseAtsAdapter({ extraBoardHosts: ['careers.acme.example'] });
    expect(custom.canHandle('https://careers.acme.example/apply/123')).toBe(true);
    expect(custom.canHandle('https://careers.other.example/apply/123')).toBe(false);
    // The default adapter stays strict.
    expect(adapter.canHandle('https://careers.acme.example/apply/123')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

describe('Greenhouse registry integration', () => {
  it('registers through the Phase 7 registry without provider knowledge in it', () => {
    const registry = createDefaultAtsRegistry();
    const adapter = registerGreenhouseAdapter(registry);
    expect(registry.get('GREENHOUSE')).toBe(adapter);
    expect(registry.get('greenhouse')).toBe(adapter);
    expect(registry.has(GREENHOUSE_PROVIDER)).toBe(true);
    expect(registry.list()).toEqual(['GREENHOUSE']);
  });

  it('resolves the Greenhouse adapter by URL and rejects foreign URLs', () => {
    const registry = createDefaultAtsRegistry();
    const adapter = registerGreenhouseAdapter(registry);
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

    expect(registry.findForUrl('https://job-boards.greenhouse.io/acme/jobs/42')).toBe(adapter);
    expect(registry.findForUrl('https://boards.greenhouse.io/acme/jobs/42')).toBe(adapter);
    expect(registry.findForUrl('https://jobs.lever.co/acme/42')).toBeNull();
    expect(registry.findForUrl('https://unrelated.example.com/job/1')).toBe(unrelated);
  });

  it('rejects duplicate registration', () => {
    const registry = createDefaultAtsRegistry();
    registerGreenhouseAdapter(registry);
    expect(() => registerGreenhouseAdapter(registry)).toThrowError(AtsError);
  });
});

// ---------------------------------------------------------------------------
// Inspection - modern job-boards layout
// ---------------------------------------------------------------------------

describe('Greenhouse inspection (modern layout)', () => {
  it('inspects the application form and returns typed provider-independent fields', async () => {
    const inspection = await inspectPath('/');

    expect(inspection.provider).toBe('GREENHOUSE');
    expect(inspection.pageTitle).toBe('Job Application for Analytics Engineer at TestCo');
    expect(inspection.isApplicationForm).toBe(true);
    expect(inspection.blockers).toEqual([]);

    const byId = new Map(inspection.fields.map((f) => [f.externalFieldId, f]));
    expect(inspection.fields.length).toBeGreaterThanOrEqual(15);

    // Field types (including semantic refinement of plain text inputs)
    expect(byId.get('first_name')?.type).toBe('TEXT');
    expect(byId.get('last_name')?.type).toBe('TEXT');
    expect(byId.get('email')?.type).toBe('EMAIL'); // type="text" + autocomplete="email"
    expect(byId.get('phone')?.type).toBe('PHONE');
    expect(byId.get('question_70000006')?.type).toBe('TEXTAREA');
    expect(byId.get('question_70000004')?.type).toBe('SELECT');
    expect(byId.get('resume')?.type).toBe('FILE');

    // Required flags (aria-required, label markers, group markers)
    expect(byId.get('first_name')?.required).toBe(true);
    expect(byId.get('email')?.required).toBe(true);
    expect(byId.get('phone')?.required).toBe(true);
    expect(byId.get('country')?.required).toBe(true);
    expect(byId.get('resume')?.required).toBe(true);
    expect(byId.get('question_70000004')?.required).toBe(true);
    expect(byId.get('preferred_name')?.required).toBe(false);
    expect(byId.get('cover_letter')?.required).toBe(false);
    expect(byId.get('question_70000006')?.required).toBe(false);

    // Labels are normalized (required markers stripped)
    expect(byId.get('first_name')?.label).toBe('First Name');
    expect(byId.get('first_name')?.normalizedLabel).toBe('first_name');
    expect(byId.get('question_70000004')?.label).toBe(
      'Are you authorized to work in the United States?'
    );
  });

  it('detects first/last name, contact, links, work authorization and sponsorship', async () => {
    const inspection = await inspectPath('/');
    const byId = new Map(inspection.fields.map((f) => [f.externalFieldId, f]));
    const semantic = (id: string) => byId.get(id)?.locator?.attributes?.semantic;

    expect(semantic('first_name')).toBe('first_name');
    expect(semantic('last_name')).toBe('last_name');
    expect(semantic('email')).toBe('email');
    expect(semantic('phone')).toBe('phone');
    expect(semantic('candidate-location')).toBe('location');
    expect(semantic('resume')).toBe('resume');
    expect(semantic('cover_letter')).toBe('cover_letter');
    expect(semantic('question_70000001')).toBe('linkedin');
    expect(semantic('question_70000002')).toBe('github');
    expect(semantic('question_70000003')).toBe('portfolio');
    expect(semantic('question_70000004')).toBe('work_authorization');
    expect(semantic('question_70000005')).toBe('sponsorship');
  });

  it('detects the resume upload and its accepted file types', async () => {
    const inspection = await inspectPath('/');
    const resume = inspection.fields.find((f) => f.locator?.attributes?.semantic === 'resume');
    expect(resume).toBeDefined();
    expect(resume?.type).toBe('FILE');
    expect(resume?.required).toBe(true);
    expect(resume?.label).toBe('Resume/CV');
    expect(resume?.locator?.attributes?.accept).toBe('.pdf,.doc,.docx,.txt,.rtf');

    const cover = inspection.fields.find((f) => f.locator?.attributes?.semantic === 'cover_letter');
    expect(cover?.type).toBe('FILE');
    expect(cover?.required).toBe(false);
  });

  it('captures stable identifiers and locators', async () => {
    const inspection = await inspectPath('/');
    const field = inspection.fields.find((f) => f.externalFieldId === 'question_70000004');
    expect(field).toBeDefined();
    expect(field?.locator?.cssSelector).toBe('#question_70000004');
    expect(field?.locator?.attributes?.questionId).toBe('70000004');
    expect(field?.locator?.attributes?.role).toBe('combobox');
    expect(field?.normalizedLabel).toBe(
      'are_you_authorized_to_work_in_the_united_states'
    );
  });

  it('enumerates options of Greenhouse custom dropdowns (comboboxes)', async () => {
    const inspection = await inspectPath('/');
    const byId = new Map(inspection.fields.map((f) => [f.externalFieldId, f]));

    const workAuth = byId.get('question_70000004');
    expect(workAuth?.type).toBe('SELECT');
    expect(workAuth?.options?.map((o) => o.label)).toEqual(['Yes', 'No']);

    const sponsorship = byId.get('question_70000005');
    expect(sponsorship?.options?.map((o) => o.label)).toEqual(['Yes', 'No']);

    const location = byId.get('candidate-location');
    expect(location?.options?.map((o) => o.label)).toEqual([
      'San Francisco, CA',
      'New York, NY',
      'Remote',
    ]);
  });

  it('captures sections from page structure', async () => {
    const inspection = await inspectPath('/');
    const byId = new Map(inspection.fields.map((f) => [f.externalFieldId, f]));
    expect(byId.get('question_70000001')?.section).toBe('Additional Information');
    expect(byId.get('gender')?.section).toBe('Voluntary Self-Identification');
    expect(byId.get('first_name')?.section).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inspection - classic boards layout
// ---------------------------------------------------------------------------

describe('Greenhouse inspection (classic layout)', () => {
  it('inspects classic fields with native select/radio/checkbox/textarea', async () => {
    const inspection = await inspectPath('/classic');
    expect(inspection.isApplicationForm).toBe(true);

    // Single fields prefer their element id, groups their shared name.
    const byId = new Map(inspection.fields.map((f) => [f.externalFieldId, f]));
    expect(byId.get('job_application_custom_questions_101')?.type).toBe('SELECT');
    expect(byId.get('job_application[custom_questions][102]')?.type).toBe('RADIO');
    expect(byId.get('job_application[custom_questions][103]')?.type).toBe('CHECKBOX');
    expect(byId.get('cover_letter')?.type).toBe('TEXTAREA');
    expect(byId.get('resume')?.type).toBe('FILE');
    expect(byId.get('email')?.type).toBe('EMAIL');
    expect(byId.get('phone')?.type).toBe('PHONE');
    expect(byId.get('first_name')?.type).toBe('TEXT');
    expect(byId.get('last_name')?.type).toBe('TEXT');
  });

  it('captures native select and radio options', async () => {
    const inspection = await inspectPath('/classic');
    const select = inspection.fields.find(
      (f) => f.externalFieldId === 'job_application_custom_questions_101'
    );
    expect(select?.options).toEqual([
      { value: '', label: 'Please select' },
      { value: 'linkedin', label: 'LinkedIn' },
      { value: 'friend', label: 'Friend' },
      { value: 'other', label: 'Other' },
    ]);

    const radio = inspection.fields.find((f) => f.externalFieldId === 'job_application[custom_questions][102]');
    expect(radio?.type).toBe('RADIO');
    expect(radio?.label).toBe('Are you legally authorized to work in the United States?');
    expect(radio?.required).toBe(true);
    expect(radio?.options).toEqual([
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ]);
    // The shared name is the stable group identifier and locator.
    expect(radio?.locator?.cssSelector).toBe('[name="job_application[custom_questions][102]"]');

    const checkbox = inspection.fields.find((f) => f.externalFieldId === 'job_application[custom_questions][103]');
    expect(checkbox?.label).toBe('Which benefits interest you?');
    expect(checkbox?.required).toBe(false);
    expect(checkbox?.options?.map((o) => o.label)).toEqual(['Health', 'Dental', '401k']);
  });

  it('detects the classic resume upload field', async () => {
    const inspection = await inspectPath('/classic');
    const resume = inspection.fields.find((f) => f.externalFieldId === 'resume');
    expect(resume?.type).toBe('FILE');
    expect(resume?.label).toBe('Resume/CV');
    expect(resume?.locator?.attributes?.semantic).toBe('resume');
    expect(resume?.locator?.cssSelector).toBe('#resume');
    expect(resume?.locator?.attributes?.name).toBe('job_application[resume]');
  });
});

// ---------------------------------------------------------------------------
// Non-Greenhouse pages
// ---------------------------------------------------------------------------

describe('non-Greenhouse page handling', () => {
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
    expect(inspection.warnings.join(' ')).toMatch(/does not appear to be a Greenhouse application form/i);
  });

  it('refuses a page that carries another ATS platform markup', async () => {
    const inspection = await inspectPath('/foreign');
    expect(inspection.isApplicationForm).toBe(false);
    expect(inspection.fields).toEqual([]);
    expect(inspection.blockers.join(' ')).toMatch(/another ATS platform/i);
  });

  it('throws a structured AtsError when asked to inspect a non-Greenhouse URL', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();
    const adapter = fixtureAdapter();
    await expect(
      adapter.inspectApplication({ url: 'https://jobs.lever.co/acme/1', page, context })
    ).rejects.toThrowError(AtsError);
    try {
      await adapter.inspectApplication({ url: 'file:///etc/passwd', page, context });
    } catch (err) {
      expect((err as AtsError).code).toBe('PAGE_NOT_RECOGNIZED');
      expect((err as AtsError).provider).toBe('GREENHOUSE');
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
    // A context without allowPrivateUrls blocks loopback even though the
    // adapter claims the URL - validation lives in @jaa/browser.
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

describe('Greenhouse prepareApplication', () => {
  it('returns NEEDS_REVIEW for a recognized form without filling or submitting', async () => {
    const { launchBrowser } = await import('@jaa/browser');
    const browser = await launchBrowser({ allowPrivateUrls: true, screenshotDir });
    const context = await browser.createContext({ allowPrivateUrls: true });
    const page = await context.createPage();
    const adapter = fixtureAdapter();

    const preparation = await adapter.prepareApplication({ url: `${mock.url}/`, page, context });
    expect(preparation.provider).toBe('GREENHOUSE');
    expect(preparation.status).toBe('NEEDS_REVIEW'); // ready for the later mapping/review stage
    expect(preparation.inspection?.isApplicationForm).toBe(true);
    expect(preparation.errors).toEqual([]);
    expect(preparation.warnings.join(' ')).toMatch(/not mapped to candidate data/i);

    // No field was filled and nothing was submitted. (For radios/checkboxes
    // the "filled" state is .checked, not .value.)
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
    expect(preparation.errors.join(' ')).toMatch(/does not appear to be a Greenhouse application form/i);
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
    await adapter.prepareApplication({ url: `${mock.url}/classic`, page, context });

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

  it('the greenhouse package does not depend on other providers or on Playwright', async () => {
    const pkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json'
    );
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['playwright']).toBeUndefined();
    expect(deps['@playwright/test']).toBeUndefined();
    expect(deps['@jaa/lever']).toBeUndefined();
    expect(deps['@jaa/database']).toBeUndefined();
  });

  it('the generic ats package has no Greenhouse dependency', async () => {
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

describe('classifyGreenhouseField', () => {
  it('classifies common application fields deterministically', () => {
    expect(classifyGreenhouseField('First Name', {})).toBe('first_name');
    expect(classifyGreenhouseField('Full name', {})).toBe('full_name');
    expect(classifyGreenhouseField('Email', {})).toBe('email');
    expect(classifyGreenhouseField('Phone', {})).toBe('phone');
    expect(classifyGreenhouseField('Current location', {})).toBe('location');
    expect(classifyGreenhouseField('LinkedIn Profile', {})).toBe('linkedin');
    expect(classifyGreenhouseField('GitHub', {})).toBe('github');
    expect(classifyGreenhouseField('Portfolio / Website', {})).toBe('portfolio');
    expect(
      classifyGreenhouseField('Are you authorized to work in the United States?', {})
    ).toBe('work_authorization');
    expect(
      classifyGreenhouseField('Will you require sponsorship for an immigration status?', {})
    ).toBe('sponsorship');
    expect(classifyGreenhouseField('Resume/CV', { inputType: 'file' })).toBe('resume');
    expect(classifyGreenhouseField('Cover Letter', { inputType: 'file' })).toBe('cover_letter');
    expect(classifyGreenhouseField('Tell us about yourself', {})).toBeNull();
  });
});
