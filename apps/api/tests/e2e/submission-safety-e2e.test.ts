/**
 * Phase 15A - submission safety end-to-end tests.
 *
 * Everything on the core path is real (Express router -> BullMQ -> worker ->
 * @jaa/core -> ATS registry -> real Greenhouse adapter -> @jaa/browser);
 * only the external ATS website is mocked (loopback mock servers). These
 * tests prove the negative guarantees of the submission boundary:
 *
 *   - submission without an explicit human approval is impossible;
 *   - an unapproved (PENDING/REJECTED) resume blocks submission;
 *   - missing required answers and answers awaiting human review block it;
 *   - a CAPTCHA / MFA / security challenge stops submission and is never
 *     solved or bypassed;
 *   - unsupported ATS and unsafe/real-world URLs are refused before
 *     anything runs (no code path can submit a real application);
 *   - a mock ATS failure is retried a bounded number of times and ends in
 *     a stable terminal FAILED state;
 *   - a crash after the external submit but before the database update can
 *     NEVER cause a blind second submission;
 *   - the whole suite runs against loopback mock ATS hosts only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import {
  getPrisma,
  hasDatabase,
  hasRedis,
  startApiServer,
  api,
  createApplicationFixture,
  answerAllRequiredQuestions,
  cleanupFixture,
  submissionJobsFor,
  startPreparationWorker,
  startSubmissionWorker,
  resetPreparationQueue,
  resetSubmissionQueue,
  waitFor,
  waitForRun,
  waitForApplication,
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
  'Phase 15A E2E: submission safety (approval gate, answers, challenges, SSRF, retry, crash)',
  () => {
    let greenhouse: MockGreenhouseServer;
    let server: ApiServer;
    const fixtures: ApplicationFixture[] = [];

    beforeAll(async () => {
      greenhouse = await startMockGreenhouseServer();
      server = await startApiServer();
      await resetPreparationQueue();
      await resetSubmissionQueue();
    });

    afterAll(async () => {
      for (const fixture of fixtures) {
        await cleanupFixture(fixture).catch(() => undefined);
      }
      await resetPreparationQueue().catch(() => undefined);
      await resetSubmissionQueue().catch(() => undefined);
      await closeBrowserQuietly();
      await server?.close().catch(() => undefined);
      await greenhouse?.close().catch(() => undefined);
      await (await getPrisma()).$disconnect().catch(() => undefined);
    });

    beforeEach(async () => {
      await resetPreparationQueue();
      await resetSubmissionQueue();
    });

    async function prepareAndWait(applicationId: string): Promise<void> {
      const res = await api(server.port).post(`/api/applications/${applicationId}/prepare`);
      expect(res.status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startPreparationWorker();
      try {
        await waitForRun(applicationId, (run) => run.status === 'COMPLETED', {
          label: 'preparation run',
        });
        await waitForApplication(applicationId, (app) => app.status === 'FORM_INSPECTED', {
          label: 'prepared application',
        });
      } finally {
        await worker.close();
      }
    }

    async function approve(applicationId: string): Promise<void> {
      const res = await api(server.port).post(`/api/applications/${applicationId}/approve`);
      expect(res.status).toBe(200);
    }

    async function submit(applicationId: string) {
      return api(server.port).post(`/api/applications/${applicationId}/submit`);
    }

    /** Assert a rejected request queued nothing and submitted nothing. */
    async function assertNothingRan(
      applicationId: string,
      submissionsBefore: number
    ): Promise<void> {
      expect(await submissionJobsFor(applicationId)).toHaveLength(0);
      expect(greenhouse.submissions.slice(submissionsBefore)).toHaveLength(0);
      const prisma = await getPrisma();
      const application = await prisma.application.findUnique({
        where: { id: applicationId },
      });
      expect(application!.status).not.toBe('SUBMITTED');
      expect(application!.submittedAt).toBeNull();
    }

    // ------------------------------------------------------------------
    // 1-2. Resume not approved
    // ------------------------------------------------------------------

    for (const reviewStatus of ['PENDING', 'REJECTED'] as const) {
      it(`blocks submission while the resume version is ${reviewStatus}`, async () => {
        const submissionsBefore = greenhouse.submissions.length;
        const fixture = await createApplicationFixture({
          prefix: `gh-safe-resume-${reviewStatus.toLowerCase()}`,
          ats: 'GREENHOUSE',
          applicationUrl: greenhouse.url,
        });
        fixtures.push(fixture);

        await prepareAndWait(fixture.applicationId);
        await answerAllRequiredQuestions(fixture.applicationId);

        // The resume review state moves away from APPROVED after preparation.
        const prisma = await getPrisma();
        await prisma.resumeVersion.update({
          where: { id: fixture.resumeVersionId },
          data: { reviewStatus },
        });

        await approve(fixture.applicationId);
        const res = await submit(fixture.applicationId);
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('RESUME_NOT_APPROVED');

        await assertNothingRan(fixture.applicationId, submissionsBefore);
      });
    }

    // ------------------------------------------------------------------
    // 3. Missing required answer
    // ------------------------------------------------------------------

    it('blocks submission before enqueueing when a required answer is missing', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-safe-missing',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      const prisma = await getPrisma();
      const questions = await prisma.applicationQuestion.findMany({
        where: { applicationId: fixture.applicationId, required: true },
      });
      const unanswered = questions.find((q) => q.fieldType !== 'FILE') ?? questions[0];
      expect(unanswered).toBeDefined();
      await answerAllRequiredQuestions(fixture.applicationId, {
        skipQuestionIds: [unanswered!.id],
      });

      await approve(fixture.applicationId);
      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('REQUIRED_ANSWER_MISSING');
      // Question IDs only - no question text, no answer text.
      expect(body.error.message).toContain(unanswered!.id);

      await assertNothingRan(fixture.applicationId, submissionsBefore);
    });

    // ------------------------------------------------------------------
    // 4. Answer requires human review
    // ------------------------------------------------------------------

    it('blocks submission before enqueueing when an answer awaits human review', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-safe-review',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      const prisma = await getPrisma();
      const questions = await prisma.applicationQuestion.findMany({
        where: { applicationId: fixture.applicationId, required: true },
      });
      const reviewed = questions.find((q) => q.fieldType !== 'FILE') ?? questions[0];
      await answerAllRequiredQuestions(fixture.applicationId, {
        needsReviewQuestionIds: [reviewed!.id],
      });

      await approve(fixture.applicationId);
      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('ANSWER_NEEDS_REVIEW');

      await assertNothingRan(fixture.applicationId, submissionsBefore);
    });

    // ------------------------------------------------------------------
    // 5. No explicit human approval
    // ------------------------------------------------------------------

    it('blocks submission when the explicit human approval action was never taken', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-safe-approval',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      await answerAllRequiredQuestions(fixture.applicationId);
      // NOTE: no POST /approve - preparation, matching, and complete answers
      // must NEVER imply approval for submission.

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('HUMAN_APPROVAL_REQUIRED');

      await assertNothingRan(fixture.applicationId, submissionsBefore);
    });

    // ------------------------------------------------------------------
    // 7. CAPTCHA at submission time
    // ------------------------------------------------------------------

    it('detects a CAPTCHA at submission time and stops without ever solving or submitting it', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const requestsBefore = greenhouse.requests.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-safe-captcha',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/captcha`,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      await answerAllRequiredQuestions(fixture.applicationId);
      await approve(fixture.applicationId);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);

      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'captcha submission run',
        });
        await waitFor(
          async () => {
            const jobs = await submissionJobsFor(fixture.applicationId);
            return jobs.length > 0 && (jobs[0].attemptsMade ?? 0) >= 1 ? true : null;
          },
          { label: 'captcha job settled' }
        );
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();
      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('FAILED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.errorCode).toBe('CAPTCHA_DETECTED');

      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain('CAPTCHA_DETECTED');
      expect(eventTypes).toContain('SUBMISSION_STARTED');
      expect(eventTypes).toContain('SUBMISSION_FAILED'); // resolved as NOT submitted
      expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');

      const captcha = events.find((e) => e.eventType === 'CAPTCHA_DETECTED')!;
      expect((captcha.metadata as Record<string, unknown>).challengeKind).toBe('CAPTCHA');

      const run = await prisma.automationRun.findUnique({
        where: { applicationId: fixture.applicationId },
      });
      expect(run!.status).toBe('FAILED');
      expect(run!.completedAt).not.toBeNull(); // never stuck RUNNING
      expect((run!.metadata as Record<string, unknown>).errorCode).toBe('CAPTCHA_DETECTED');

      // Non-retryable: a challenge is never retried into, exactly one attempt.
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1);

      // Never solved, never bypassed: zero submissions and zero POSTs.
      expect(greenhouse.submissions.slice(submissionsBefore)).toHaveLength(0);
      expect(greenhouse.requests.slice(requestsBefore).every((r) => r.method === 'GET')).toBe(
        true
      );
    });

    // ------------------------------------------------------------------
    // 8. MFA / security challenge at submission time
    // ------------------------------------------------------------------

    it('detects an MFA/security challenge at submission time and stops without bypassing it', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const requestsBefore = greenhouse.requests.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-safe-mfa',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/security-challenge`,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      await answerAllRequiredQuestions(fixture.applicationId);
      await approve(fixture.applicationId);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);

      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'security challenge submission run',
        });
        await waitFor(
          async () => {
            const jobs = await submissionJobsFor(fixture.applicationId);
            return jobs.length > 0 && (jobs[0].attemptsMade ?? 0) >= 1 ? true : null;
          },
          { label: 'challenge job settled' }
        );
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();
      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('FAILED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.errorCode).toBe('SECURITY_CHALLENGE');

      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain('SECURITY_CHALLENGE');
      expect(eventTypes).toContain('SUBMISSION_STARTED');
      expect(eventTypes).toContain('SUBMISSION_FAILED');
      expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');

      const challenge = events.find((e) => e.eventType === 'SECURITY_CHALLENGE')!;
      expect((challenge.metadata as Record<string, unknown>).challengeKind).toBe('MFA');

      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1);

      expect(greenhouse.submissions.slice(submissionsBefore)).toHaveLength(0);
      expect(greenhouse.requests.slice(requestsBefore).every((r) => r.method === 'GET')).toBe(
        true
      );
    });

    // ------------------------------------------------------------------
    // 9. Unsupported ATS
    // ------------------------------------------------------------------

    it('rejects an unsupported ATS safely before anything runs', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      // A loopback target (passes the mock-only policy) that no adapter
      // recognizes - rejection must be UNSUPPORTED_ATS.
      const fixture = await createApplicationFixture({
        prefix: 'gh-safe-unsupported',
        ats: 'GREENHOUSE',
        applicationUrl: 'http://127.0.0.3:9/unclaimed',
      });
      fixtures.push(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNSUPPORTED_ATS');

      await assertNothingRan(fixture.applicationId, submissionsBefore);
    });

    // ------------------------------------------------------------------
    // 10. Invalid / unsafe application URLs (and no real submissions)
    // ------------------------------------------------------------------

    it('refuses invalid, private-network, and REAL production ATS URLs before anything runs', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const requestsBefore = greenhouse.requests.length;

      const unsafeUrls: { url: string; code: string }[] = [
        // Non-http protocols are never valid application targets.
        { url: 'javascript:alert(1)', code: 'INVALID_APPLICATION_URL' },
        // Cloud metadata / link-local: refused by the mock-only policy.
        {
          url: 'http://169.254.169.254/latest/meta-data/',
          code: 'BLOCKED_BY_SECURITY_POLICY',
        },
        // A REAL Greenhouse production board URL: structurally unreachable
        // by the submission path - the mock-only policy refuses any
        // non-loopback target, so no real application can ever be submitted.
        {
          url: 'https://job-boards.greenhouse.io/real-company/jobs/999999',
          code: 'BLOCKED_BY_SECURITY_POLICY',
        },
      ];

      for (const unsafe of unsafeUrls) {
        const fixture = await createApplicationFixture({
          prefix: `gh-safe-url-${unsafe.code.toLowerCase().replace(/_/g, '-')}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
          ats: 'GREENHOUSE',
          applicationUrl: unsafe.url,
        });
        fixtures.push(fixture);

        const res = await submit(fixture.applicationId);
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe(unsafe.code);

        await assertNothingRan(fixture.applicationId, submissionsBefore);
      }

      // The loopback mock server saw no extra traffic whatsoever.
      expect(greenhouse.requests.length).toBe(requestsBefore);
      expect(greenhouse.submissions.slice(submissionsBefore)).toHaveLength(0);
    });

    // ------------------------------------------------------------------
    // 11. Mock ATS failure: bounded retries, correct events, terminal state
    // ------------------------------------------------------------------

    it('retries a failing mock ATS a bounded number of times and ends terminal FAILED', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-safe-fail',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/submit-fail`,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      await answerAllRequiredQuestions(fixture.applicationId);
      await approve(fixture.applicationId);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);

      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        // Bounded retries: SUBMISSION_MAX_ATTEMPTS = 3 with exponential
        // backoff. Wait until the job has actually settled.
        await waitFor(
          async () => {
            const jobs = await submissionJobsFor(fixture.applicationId);
            return jobs.length === 1 && (jobs[0].attemptsMade ?? 0) >= 3 ? true : null;
          },
          { timeoutMs: 120_000, label: 'bounded submission retries exhausted' }
        );
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();

      // Exactly 3 attempts - bounded, no infinite retry loop.
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].attemptsMade).toBe(3);

      // Stable terminal state: FAILED with completedAt, never stuck RUNNING.
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
      expect(application!.submittedAt).toBeNull();

      // Audit trail: one SUBMISSION_STARTED + one SUBMISSION_FAILED per
      // attempt, a RETRY_STARTED per retry, and an ERROR per failed attempt.
      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes.filter((t) => t === 'SUBMISSION_STARTED')).toHaveLength(3);
      expect(eventTypes.filter((t) => t === 'SUBMISSION_FAILED')).toHaveLength(3);
      expect(eventTypes.filter((t) => t === 'RETRY_STARTED')).toHaveLength(2);
      expect(eventTypes.filter((t) => t === 'ERROR')).toHaveLength(3);
      expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');

      // Every attempt reached the mock ATS and was refused - none accepted.
      const mySubmissions = greenhouse.submissions.slice(submissionsBefore);
      expect(mySubmissions).toHaveLength(3);
      expect(mySubmissions.filter((s) => s.accepted)).toHaveLength(0);
    });

    // ------------------------------------------------------------------
    // 12. Crash/retry safety at the dangerous boundary
    // ------------------------------------------------------------------

    it('a crash after the external submit can never cause a blind second submission', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-safe-crash',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      await answerAllRequiredQuestions(fixture.applicationId);
      await approve(fixture.applicationId);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);

      // The dangerous boundary: the external submit SUCCEEDS, then the
      // worker "dies" before ANY database bookkeeping can happen. The real
      // submitApplication runs (real adapter + real browser + mock ATS);
      // only the process death is simulated.
      const { submitApplication, SimulatedWorkerCrash, findUnresolvedSubmissionAttempt } =
        await import('@jaa/core');
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker({
        submit: (params) =>
          submitApplication({
            ...params,
            afterExternalSubmit: () => {
              throw new SimulatedWorkerCrash();
            },
          }),
      });
      try {
        // BullMQ retries the crashed attempt - the retry must refuse.
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          timeoutMs: 120_000,
          label: 'crash-retry run',
        });
        await waitFor(
          async () => {
            const jobs = await submissionJobsFor(fixture.applicationId);
            return jobs.length === 1 && (jobs[0].attemptsMade ?? 0) >= 2 ? true : null;
          },
          { timeoutMs: 120_000, label: 'crash-retry job settled' }
        );
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();

      // The FIRST (crashed) attempt really submitted - exactly once.
      const mySubmissions = greenhouse.submissions.slice(submissionsBefore);
      expect(mySubmissions).toHaveLength(1);
      expect((mySubmissions[0] as { accepted: boolean }).accepted).toBe(true);

      // The retry ran (2 job attempts) but refused to submit again.
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(2);

      // The attempt marker is still UNRESOLVED - that is what stops any
      // future submission too.
      expect(await findUnresolvedSubmissionAttempt(fixture.applicationId)).not.toBeNull();

      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).not.toBe('SUBMITTED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.externalApplicationId).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_OUTCOME_UNKNOWN');

      // One SUBMISSION_STARTED (the crashed attempt), never resolved.
      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes.filter((t) => t === 'SUBMISSION_STARTED')).toHaveLength(1);
      expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');
      expect(eventTypes).not.toContain('SUBMISSION_FAILED');
      expect(
        events.some(
          (e) =>
            e.eventType === 'ERROR' &&
            (e.metadata as Record<string, unknown>).code === 'SUBMISSION_OUTCOME_UNKNOWN'
        )
      ).toBe(true);

      const run = await prisma.automationRun.findUnique({
        where: { applicationId: fixture.applicationId },
      });
      expect(run!.status).toBe('FAILED');
      expect(run!.completedAt).not.toBeNull(); // never stuck RUNNING
      expect((run!.metadata as Record<string, unknown>).errorCode).toBe(
        'SUBMISSION_OUTCOME_UNKNOWN'
      );
    });

    // ------------------------------------------------------------------
    // User interruption: a cancelled submission never runs
    // ------------------------------------------------------------------

    it('records USER_INTERRUPTED for a cancelled submission and never submits', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-safe-cancel',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      await answerAllRequiredQuestions(fixture.applicationId);
      await approve(fixture.applicationId);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);

      // The user cancels the QUEUED submission before it starts.
      const cancel = await api(server.port).post(
        `/api/applications/${fixture.applicationId}/automation/cancel`
      );
      expect(cancel.status).toBe(200);

      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitFor(
          async () => {
            const jobs = await submissionJobsFor(fixture.applicationId);
            return jobs.length === 1 && (jobs[0].attemptsMade ?? 0) >= 1 ? true : null;
          },
          { label: 'cancelled submission job drained' }
        );
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();
      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      // The interruption is auditable and the submission never started.
      expect(events.map((e) => e.eventType)).toContain('USER_INTERRUPTED');
      expect(events.map((e) => e.eventType)).not.toContain('SUBMISSION_STARTED');
      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).not.toBe('SUBMITTED');
      expect(application!.submittedAt).toBeNull();
      expect(greenhouse.submissions.slice(submissionsBefore)).toHaveLength(0);
    });

    // ------------------------------------------------------------------
    // 13. Guard: this suite only ever talks to loopback mock ATS hosts
    // ------------------------------------------------------------------

    it('proves the E2E submission surface is loopback-only and inert in production', async () => {
      const { assertMockSubmissionTarget, isLoopbackUrl } = await import('@jaa/core');

      // Every mock ATS the suite talks to is a loopback server.
      expect(isLoopbackUrl(greenhouse.url)).toBe(true);

      // The test-only recognition seam names loopback hosts ONLY.
      const seamHosts = [
        process.env.JAA_TEST_EXTRA_BOARD_HOSTS_GREENHOUSE,
        process.env.JAA_TEST_EXTRA_BOARD_HOSTS_LEVER,
      ]
        .filter(Boolean)
        .flatMap((hosts) => (hosts as string).split(','));
      expect(seamHosts.length).toBeGreaterThan(0);
      for (const host of seamHosts) {
        expect(host.trim().startsWith('127.')).toBe(true);
      }

      // The mock-only policy refuses every non-loopback target ...
      expect(() =>
        assertMockSubmissionTarget('https://job-boards.greenhouse.io/acme/jobs/1')
      ).toThrow();
      expect(() => assertMockSubmissionTarget('http://169.254.169.254/latest/meta-data/')).toThrow();

      // ... refuses everything without the explicit opt-in ...
      const previousOptIn = process.env.JAA_ALLOW_MOCK_SUBMISSION;
      try {
        delete process.env.JAA_ALLOW_MOCK_SUBMISSION;
        expect(() => assertMockSubmissionTarget(greenhouse.url)).toThrow();
      } finally {
        if (previousOptIn !== undefined) process.env.JAA_ALLOW_MOCK_SUBMISSION = previousOptIn;
      }

      // ... and refuses even loopback in production, where submission is
      // disabled outright - no opt-in can ever enable it there.
      const previousNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        expect(() => assertMockSubmissionTarget(greenhouse.url)).toThrow();
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
      }
    });
  }
);
