/**
 * Phase 15B - GATED controlled real Greenhouse submission suite.
 *
 * !! THIS IS THE ONLY SUITE IN THE REPO THAT CAN SUBMIT A REAL APPLICATION !!
 *
 * It is excluded from `npm test` and `npm run test:e2e` (see
 * apps/api/vitest.config.ts and vitest.e2e.config.ts) and runs ONLY via:
 *
 *     npm run test:greenhouse:real
 *
 * and even then it FAILS CLOSED:
 *
 *  - without configuration it is SKIPPED with an explicit banner below - it
 *    never falls back to any public or random job posting, never invents a
 *    target URL, and submits nothing;
 *  - with the capability flag set but no authorized target URL (or a target
 *    the safety policy refuses) it FAILS loudly - a misconfiguration must
 *    never look like a pass;
 *  - the ONLY submission target is `JAA_REAL_GREENHOUSE_TEST_URL`, which
 *    must be a Greenhouse application URL the operator is authorized to
 *    submit to.
 *
 * Required configuration (server environment only - never a client):
 *   JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED=true
 *   JAA_REAL_GREENHOUSE_TEST_URL=https://job-boards.greenhouse.io/<board>/jobs/<id>
 *
 * Optional synthetic candidate overrides (all fake by default):
 *   JAA_REAL_GREENHOUSE_TEST_FIRST_NAME / _LAST_NAME / _EMAIL / _PHONE /
 *   _LOCATION
 *
 * Safety invariants exercised here (never weakened):
 *  - the server-side target policy (capability + Greenhouse-only +
 *    non-loopback + SSRF public-URL checks) must admit the target BEFORE any
 *    submission is attempted;
 *  - CAPTCHA / MFA / security challenges stop the run - never solved, never
 *    bypassed;
 *  - success is only ever claimed from real provider evidence; an
 *    unverifiable outcome (SUBMISSION_UNCONFIRMED) FAILS the test and is
 *    never retried from here.
 */

import { describe, it, expect, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

// Load DATABASE_URL before @jaa/database instantiates Prisma (repo convention).
import dotenv from 'dotenv';
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env'),
});

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/jaa_dev';

const { createPreparationRegistry, assertSubmissionTarget, resolveSubmissionMode, REAL_GREENHOUSE_SUBMISSION_FLAG } =
  await import('@jaa/core');
const { isVerifiedSubmission } = await import('@jaa/ats');
const { launchBrowser } = await import('@jaa/browser');
type AtsField = import('@jaa/ats').AtsField;
type AtsFieldFill = import('@jaa/ats').AtsFieldFill;
type AtsSubmissionResult = import('@jaa/ats').AtsSubmissionResult;
type JaaBrowserContext = import('@jaa/browser').JaaBrowserContext;

// ---------------------------------------------------------------------------
// Fail-closed configuration
// ---------------------------------------------------------------------------

const ENABLED = process.env[REAL_GREENHOUSE_SUBMISSION_FLAG] === 'true';
const TARGET_URL = (process.env.JAA_REAL_GREENHOUSE_TEST_URL ?? '').trim();

if (!ENABLED) {
  console.warn(
    [
      '',
      '='.repeat(78),
      '[greenhouse-real] SKIPPED (fail closed): real Greenhouse submission is',
      `    disabled. Set ${REAL_GREENHOUSE_SUBMISSION_FLAG}=true on the server`,
      '    and JAA_REAL_GREENHOUSE_TEST_URL to an authorized Greenhouse',
      '    application URL to run this suite.',
      '    No target was chosen automatically. ZERO real applications submitted.',
      '='.repeat(78),
      '',
    ].join('\n')
  );
}

function requireTarget(): string {
  if (!TARGET_URL) {
    throw new Error(
      `FAIL CLOSED: ${REAL_GREENHOUSE_SUBMISSION_FLAG}=true but JAA_REAL_GREENHOUSE_TEST_URL is empty. ` +
        'Refusing to guess a target - no public or random job posting is ever used. ' +
        'Set JAA_REAL_GREENHOUSE_TEST_URL to a Greenhouse application URL you are authorized to submit to.'
    );
  }
  return TARGET_URL;
}

// All synthetic by construction (example.com is a reserved domain).
const candidate = {
  firstName: process.env.JAA_REAL_GREENHOUSE_TEST_FIRST_NAME || 'Test',
  lastName: process.env.JAA_REAL_GREENHOUSE_TEST_LAST_NAME || 'Candidate',
  email: process.env.JAA_REAL_GREENHOUSE_TEST_EMAIL || 'test-candidate@example.com',
  phone: process.env.JAA_REAL_GREENHOUSE_TEST_PHONE || '+1 555 010 0100',
  location: process.env.JAA_REAL_GREENHOUSE_TEST_LOCATION || 'Testville',
};

const SYNTHETIC_SHORT = 'Synthetic Phase 15B test answer';
const SYNTHETIC_LONG =
  'Synthetic Phase 15B test answer. This application was produced by an automated controlled test run with fake candidate data.';

/**
 * Build synthetic in-memory fills from the live form inspection. Every value
 * is fake; FILE fields are never uploaded by this suite.
 */
function syntheticFillsFor(fields: AtsField[]): AtsFieldFill[] {
  const fills: AtsFieldFill[] = [];
  for (const field of fields) {
    if (field.type === 'FILE') continue;
    const semantic = (field.locator?.attributes as Record<string, string> | undefined)?.semantic;
    let value: string | null = null;
    switch (semantic) {
      case 'first_name':
        value = candidate.firstName;
        break;
      case 'last_name':
        value = candidate.lastName;
        break;
      case 'full_name':
        value = `${candidate.firstName} ${candidate.lastName}`;
        break;
      case 'email':
        value = candidate.email;
        break;
      case 'phone':
        value = candidate.phone;
        break;
      case 'location':
        value = candidate.location;
        break;
      case 'linkedin':
      case 'github':
      case 'portfolio':
        value = 'https://example.com/test-candidate';
        break;
      case 'work_authorization':
      case 'sponsorship':
        value = field.options?.[0]?.value ?? 'Yes';
        break;
      default:
        if (field.options && field.options.length > 0) {
          value = field.options[0].value || field.options[0].label;
        } else if (field.required) {
          value = field.type === 'TEXTAREA' ? SYNTHETIC_LONG : SYNTHETIC_SHORT;
        }
    }
    if (value == null) continue;
    fills.push({
      questionId: field.externalFieldId ?? field.label,
      fieldType: field.type,
      locator: field.locator ?? null,
      value,
      required: field.required,
      options: field.options ?? null,
    });
  }
  return fills;
}

describe.skipIf(!ENABLED)(
  'Phase 15B gated REAL Greenhouse submission (authorized target only)',
  () => {
    let browserContext: JaaBrowserContext | null = null;

    afterAll(async () => {
      if (browserContext) await browserContext.close().catch(() => undefined);
    });

    it('refuses to run without an explicitly configured authorized target URL (fail closed)', () => {
      requireTarget();
    });

    it('the server-side target policy admits exactly this configured target before anything is sent', () => {
      const targetUrl = requireTarget();
      const registry = createPreparationRegistry();
      const adapter = registry.findForUrl(targetUrl);

      // A non-Greenhouse or unrecognized target is refused (Lever stays
      // mock-only in Phase 15B), and so is any loopback mock address.
      expect(adapter?.provider).toBe('GREENHOUSE');
      expect(resolveSubmissionMode(targetUrl)).toBe('REAL');

      // The same policy the worker enforces: capability + Greenhouse-only +
      // non-loopback + SSRF public-URL checks.
      expect(() => assertSubmissionTarget(targetUrl, adapter?.provider ?? null)).not.toThrow();
    });

    it('submits ONE synthetic application to the authorized target and verifies real confirmation', async () => {
      const targetUrl = requireTarget();
      const registry = createPreparationRegistry();
      const adapter = registry.findForUrl(targetUrl);
      if (!adapter) {
        throw new Error(`FAIL CLOSED: no registered ATS adapter recognizes ${targetUrl}`);
      }

      const browser = await launchBrowser({ headless: true });
      browserContext = await browser.createContext();
      const page = await browserContext.createPage();

      // Inspect first (read-only) so fills are built from the live form.
      const inspection = await adapter.inspectApplication({ url: targetUrl, page });
      expect(inspection.isApplicationForm).toBe(true);
      const fieldFills = syntheticFillsFor(inspection.fields);
      const requiredFilled = fieldFills.filter((fill) => fill.required).length;

      let result: AtsSubmissionResult;
      try {
        result = await adapter.submitApplication({
          url: targetUrl,
          page,
          browserContext,
          applicationId: `phase15b-real-test-${Date.now()}`,
          submissionAttemptId: randomUUID(),
          fieldCount: inspection.fields.length,
          requiredAnswerCount: requiredFilled,
          submissionMode: 'REAL',
          fieldFills,
          resumeFile: null,
          metadata: { provider: 'GREENHOUSE' },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // An unknown outcome is a loud, terminal result for this suite -
        // never retried from here. A human must resolve it.
        throw new Error(
          `The real submission attempt ended with an unverifiable outcome and requires human resolution (never retried automatically): ${message}`
        );
      }

      // Honest reporting of the three safe outcomes. Only real provider
      // evidence ever yields SUBMITTED.
      if (result.outcome === 'SUBMITTED') {
        expect(isVerifiedSubmission(result)).toBe(true);
        expect(result.confirmation).toBeTruthy();
        console.warn(
          `[greenhouse-real] SUBMITTED and verified (${result.confirmation?.method ?? 'unknown'}); confirmation reference: ${result.confirmation?.reference ?? '(none exposed)'}`
        );
      } else if (result.outcome === 'REJECTED') {
        // The form refused the synthetic application: definitively nothing
        // was submitted.
        expect(result.externalApplicationId ?? null).toBeNull();
        console.warn(
          '[greenhouse-real] REJECTED by the form (visible validation refusal) - nothing was submitted.'
        );
      } else {
        // CHALLENGE_DETECTED: stopped and reported, never solved/bypassed.
        expect(result.challenge).toBeTruthy();
        console.warn(
          `[greenhouse-real] CHALLENGE_DETECTED (${result.challenge?.kind ?? 'unknown'}) - submission stopped; challenges are never solved or bypassed.`
        );
      }
    });
  }
);
