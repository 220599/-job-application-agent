/**
 * Phase 14 - safety end-to-end tests.
 *
 * Everything on the core path is real (Express router -> BullMQ -> worker ->
 * @jaa/core -> ATS registry -> adapters -> @jaa/browser); only the external
 * ATS website is mocked (loopback mock servers). These tests prove the
 * negative guarantees of the whole pipeline:
 *
 *   - unsupported ATS / invalid URLs are rejected BEFORE anything runs;
 *   - unrecognized pages fabricate no questions;
 *   - CAPTCHAs are detected and reported, never solved or bypassed;
 *   - the SSRF guard blocks loopback navigation under production defaults
 *     and the block happens before any request reaches the network;
 *   - a crashing upstream is retried a bounded number of times and ends in a
 *     stable FAILED state - never stuck RUNNING;
 *   - nothing is ever submitted anywhere.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import {
  getPrisma,
  hasDatabase,
  hasRedis,
  startApiServer,
  api,
  createApplicationFixture,
  cleanupFixture,
  jobsFor,
  startPreparationWorker,
  resetPreparationQueue,
  waitFor,
  waitForRun,
  closeBrowserQuietly,
  type ApiServer,
  type ApplicationFixture,
} from './e2e-helpers';
import {
  startMockGreenhouseServer,
  type MockGreenhouseServer,
} from '../../packages/greenhouse/tests/fixtures/mock-greenhouse-server';

// E2E needs BOTH PostgreSQL and Redis; skip honestly when either is down.
const HAS_DB = await hasDatabase();
const HAS_REDIS = await hasRedis();

describe.skipIf(!HAS_DB || !HAS_REDIS)(
  'Phase 14 E2E: safety (rejections, CAPTCHA, SSRF guard, bounded retry)',
  () => {
    let greenhouse: MockGreenhouseServer;
    let server: ApiServer;
    const fixtures: ApplicationFixture[] = [];

    beforeAll(async () => {
      greenhouse = await startMockGreenhouseServer();
      server = await startApiServer();
      await resetPreparationQueue();
    });

    afterAll(async () => {
      for (const fixture of fixtures) {
        await cleanupFixture(fixture).catch(() => undefined);
      }
      await resetPreparationQueue().catch(() => undefined);
      await closeBrowserQuietly();
      await server?.close().catch(() => undefined);
      await greenhouse?.close().catch(() => undefined);
      await (await getPrisma()).$disconnect().catch(() => undefined);
    });

    beforeEach(async () => {
      await resetPreparationQueue();
    });

    async function prepare(applicationId: string) {
      return api(server.port).post(`/api/applications/${applicationId}/prepare`);
    }

    it('the test-only recognition seam is inert in production and the SSRF policy defaults to off', async () => {
      const { createPreparationRegistry } = await import('@jaa/core');
      const { getBrowserConfig } = await import('@jaa/browser');

      // Production: the JAA_TEST_EXTRA_BOARD_HOSTS* seam is ignored - a
      // loopback mock URL is not claimed by any adapter.
      const previousNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        const productionRegistry = createPreparationRegistry();
        expect(productionRegistry.findForUrl('http://127.0.0.1:45000/x')).toBeNull();
        expect(productionRegistry.findForUrl('http://127.0.0.2:45000/x')).toBeNull();
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }

      // Outside production the (test-only) seam is active for these suites.
      const testRegistry = createPreparationRegistry();
      expect(testRegistry.findForUrl(greenhouse.url)).not.toBeNull();

      // The browser SSRF policy is OFF by default - private URLs are blocked
      // unless a caller explicitly opts in (tests only).
      expect(getBrowserConfig().allowPrivateUrls).toBe(false);
    });

    it('rejects an unsupported ATS before anything runs: no run, no job, no navigation', async () => {
      const fixture = await createApplicationFixture({
        prefix: 'safe-unsupported',
        ats: 'GREENHOUSE',
        applicationUrl: 'https://careers.example.invalid/jobs/123',
      });
      fixtures.push(fixture);

      const requestsBefore = greenhouse.requests.length;

      const res = await prepare(fixture.applicationId);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNSUPPORTED_ATS');

      const prisma = await getPrisma();
      expect(await jobsFor(fixture.applicationId)).toHaveLength(0);
      expect(
        await prisma.automationRun.findUnique({ where: { applicationId: fixture.applicationId } })
      ).toBeNull();
      expect(
        await prisma.applicationQuestion.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(0);
      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('DISCOVERED'); // untouched
      // The browser never navigated anywhere.
      expect(greenhouse.requests.length).toBe(requestsBefore);
    });

    it('rejects a non-http application URL without navigating anywhere', async () => {
      const fixture = await createApplicationFixture({
        prefix: 'safe-bad-url',
        ats: 'GREENHOUSE',
        applicationUrl: 'javascript:alert(1)',
      });
      fixtures.push(fixture);

      const requestsBefore = greenhouse.requests.length;

      const res = await prepare(fixture.applicationId);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_APPLICATION_URL');

      const prisma = await getPrisma();
      expect(await jobsFor(fixture.applicationId)).toHaveLength(0);
      expect(
        await prisma.automationRun.findUnique({ where: { applicationId: fixture.applicationId } })
      ).toBeNull();
      expect(greenhouse.requests.length).toBe(requestsBefore);
    });

    it('a recognized URL whose page is not an application form fabricates nothing', async () => {
      const fixture = await createApplicationFixture({
        prefix: 'safe-generic',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/generic-form`,
      });
      fixtures.push(fixture);

      const res = await prepare(fixture.applicationId);
      expect(res.status).toBe(202);

      await closeBrowserQuietly(); // fresh browser for this policy
      const worker = await startPreparationWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'generic-form run',
        });
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();
      // The page (a newsletter form) is NOT an application form: zero
      // questions are fabricated and the application is not advanced.
      expect(
        await prisma.applicationQuestion.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(0);
      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('PREPARING');
      expect(application!.submittedAt).toBeNull();

      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      const inspected = events.find((e) => e.eventType === 'FORM_INSPECTED');
      expect(inspected).toBeDefined();
      const meta = inspected!.metadata as {
        isApplicationForm: boolean;
        warnings: string[];
      };
      expect(meta.isApplicationForm).toBe(false);
      expect(meta.warnings.some((w) => /does not appear to be a Greenhouse/i.test(w))).toBe(true);
      expect(events.map((e) => e.eventType)).not.toContain('SUBMISSION_STARTED');
      expect(greenhouse.submissions).toHaveLength(0);
    });

    it("never claims another ATS platform's form as its own", async () => {
      const fixture = await createApplicationFixture({
        prefix: 'safe-foreign',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/foreign`,
      });
      fixtures.push(fixture);

      const res = await prepare(fixture.applicationId);
      expect(res.status).toBe(202);

      await closeBrowserQuietly();
      const worker = await startPreparationWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'foreign-form run',
        });
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();
      // Lever-shaped markup behind a Greenhouse URL: not recognized as a
      // Greenhouse form, zero questions fabricated, nothing submitted.
      expect(
        await prisma.applicationQuestion.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(0);
      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('PREPARING');
      expect(application!.submittedAt).toBeNull();

      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      const inspected = events.find((e) => e.eventType === 'FORM_INSPECTED')!;
      const meta = inspected.metadata as { isApplicationForm: boolean; warnings: string[] };
      expect(meta.isApplicationForm).toBe(false);
      expect(meta.warnings.some((w) => /does not appear to be a Greenhouse/i.test(w))).toBe(true);
      expect(greenhouse.submissions).toHaveLength(0);
    });

    it('detects and reports a CAPTCHA without ever solving or submitting it', async () => {
      const fixture = await createApplicationFixture({
        prefix: 'safe-captcha',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/captcha`,
      });
      fixtures.push(fixture);

      const res = await prepare(fixture.applicationId);
      expect(res.status).toBe(202);

      await closeBrowserQuietly();
      const worker = await startPreparationWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'captcha run',
        });
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();
      // The form is still INSPECTED (read-only), never filled or submitted.
      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('FORM_INSPECTED');
      expect(application!.submittedAt).toBeNull();

      const questions = await prisma.applicationQuestion.findMany({
        where: { applicationId: fixture.applicationId },
      });
      // The real questions only - the hidden g-recaptcha-response field is
      // never treated as a question and never filled in.
      expect(questions).toHaveLength(3);
      expect(questions.some((q) => String(q.externalFieldId).includes('recaptcha'))).toBe(false);

      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      const inspected = events.find((e) => e.eventType === 'FORM_INSPECTED')!;
      const meta = inspected.metadata as { warnings: string[] };
      // Detected + reported as a warning: requires human interaction, never bypassed.
      expect(meta.warnings.some((w) => /g-recaptcha/i.test(w))).toBe(true);
      expect(meta.warnings.some((w) => /never (bypassed|solved)/i.test(w))).toBe(true);
      expect(events.map((e) => e.eventType)).not.toContain('SUBMISSION_STARTED');

      // Never solved: the only traffic to the mock was GET page loads. The
      // CAPTCHA response field was never POSTed anywhere.
      expect(greenhouse.submissions).toHaveLength(0);
      expect(greenhouse.requests.every((r) => r.method === 'GET')).toBe(true);
    });

    it('the SSRF guard blocks loopback under production defaults before any request is sent', async () => {
      const fixture = await createApplicationFixture({
        prefix: 'safe-ssrf',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      const res = await prepare(fixture.applicationId);
      expect(res.status).toBe(202);

      const requestsBefore = greenhouse.requests.length;

      // Worker WITHOUT the test-only allowPrivateUrls opt-in: the production
      // default. The shared browser is relaunched so even the browser-level
      // config is the locked-down default.
      await closeBrowserQuietly();
      const worker = await startPreparationWorker({ allowPrivateUrls: false });
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'blocked run',
        });
        // Non-retryable: exactly one attempt, the job settles quickly.
        await waitFor(
          async () => {
            const jobs = await jobsFor(fixture.applicationId);
            return jobs[0]?.attemptsMade === 1 ? true : null;
          },
          { label: 'single non-retried attempt' }
        );
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();
      const run = await prisma.automationRun.findUnique({
        where: { applicationId: fixture.applicationId },
      });
      expect(run!.status).toBe('FAILED');
      expect(run!.completedAt).not.toBeNull(); // never stuck RUNNING
      expect((run!.metadata as Record<string, unknown>).errorCode).toBe(
        'BLOCKED_BY_SECURITY_POLICY'
      );

      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('FAILED');
      expect(
        await prisma.applicationQuestion.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(0);

      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      const error = events.find((e) => e.eventType === 'ERROR');
      expect(error).toBeDefined();
      expect((error!.metadata as Record<string, unknown>).code).toBe('BLOCKED_BY_SECURITY_POLICY');

      // Strongest proof: the loopback mock server saw NO traffic at all -
      // navigation was blocked before a single request left the browser.
      expect(greenhouse.requests.length).toBe(requestsBefore);
      expect(greenhouse.submissions).toHaveLength(0);
    });

    it('a crashing upstream is retried a bounded number of times and ends FAILED', async () => {
      const fixture = await createApplicationFixture({
        prefix: 'safe-broken',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/broken`,
      });
      fixtures.push(fixture);

      const requestsBefore = greenhouse.requests.length;

      const res = await prepare(fixture.applicationId);
      expect(res.status).toBe(202);

      await closeBrowserQuietly(); // back to the permissive test policy
      const worker = await startPreparationWorker();
      try {
        // Bounded retries: PREPARATION_MAX_ATTEMPTS = 3 with 5s exponential
        // backoff. Wait until the job has actually settled.
        await waitFor(
          async () => {
            const jobs = await jobsFor(fixture.applicationId);
            return jobs.length === 1 && (jobs[0].attemptsMade ?? 0) >= 3 ? true : null;
          },
          { timeoutMs: 120_000, label: 'bounded retries exhausted' }
        );
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();

      // Exactly 3 attempts - bounded, no infinite retry loop.
      const jobs = await jobsFor(fixture.applicationId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].attemptsMade).toBe(3);

      // Stable terminal state: FAILED with a stable code, never stuck RUNNING.
      const run = await prisma.automationRun.findUnique({
        where: { applicationId: fixture.applicationId },
      });
      expect(run!.status).toBe('FAILED');
      expect(run!.completedAt).not.toBeNull();
      expect((run!.metadata as Record<string, unknown>).errorCode).toBe('TRANSIENT_FAILURE');

      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('FAILED');
      expect(
        await prisma.applicationQuestion.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(0);

      // Audit trail: an ERROR per attempt and a RETRY_STARTED when a later
      // attempt picks a FAILED application back up.
      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      const errors = events.filter((e) => e.eventType === 'ERROR');
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(
        errors.some((e) => (e.metadata as Record<string, unknown>).code === 'TRANSIENT_FAILURE')
      ).toBe(true);
      const retries = events.filter((e) => e.eventType === 'RETRY_STARTED');
      expect(retries.length).toBeGreaterThanOrEqual(1);
      expect(retries.length).toBeLessThanOrEqual(2);
      expect(events.map((e) => e.eventType)).not.toContain('SUBMISSION_STARTED');

      // The only traffic (since this test started) was repeated GETs of the
      // crashing page - the connection dies before a response, and nothing
      // was ever POSTed.
      const myRequests = greenhouse.requests.slice(requestsBefore);
      expect(myRequests.length).toBeGreaterThanOrEqual(3);
      expect(myRequests.every((r) => r.method === 'GET')).toBe(true);
      expect(myRequests.every((r) => r.path === '/broken')).toBe(true);
      expect(greenhouse.submissions).toHaveLength(0);
    });
  }
);
