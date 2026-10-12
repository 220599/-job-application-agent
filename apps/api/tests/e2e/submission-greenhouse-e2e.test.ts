/**
 * Phase 15A - Greenhouse mock submission end-to-end test.
 *
 * The ENTIRE production path is real:
 *   real Express router (POST /api/applications/:id/approve + /submit)
 *     -> real BullMQ submission queue (@jaa/core)
 *     -> real submission worker (same wiring as apps/worker)
 *     -> real submission gate / attempt ledger / AutomationRun lifecycle
 *     -> real ATS registry + Greenhouse adapter (submitApplication)
 *     -> real @jaa/browser (Playwright behind the public API only)
 *   -> the ONLY mock is the loopback Greenhouse HTTP server.
 *
 * The submission happens at the Phase 15A MOCK boundary only: the request
 * that reaches the mock ATS carries identifiers and counts - never answer
 * text, resume content, or candidate PII.
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
  'Phase 15A E2E: Greenhouse mock submission (real API -> queue -> worker -> adapter -> mock ATS)',
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

    /** Prepare the application through the real pipeline up to FORM_INSPECTED. */
    async function prepareAndWait(applicationId: string): Promise<void> {
      const res = await api(server.port).post(`/api/applications/${applicationId}/prepare`);
      expect(res.status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startPreparationWorker();
      try {
        await waitForRun(applicationId, (run) => run.status === 'COMPLETED', {
          label: 'greenhouse preparation run',
        });
        await waitForApplication(applicationId, (app) => app.status === 'FORM_INSPECTED', {
          label: 'greenhouse prepared application',
        });
      } finally {
        await worker.close();
      }
    }

    /** The explicit human approval action (the only path to APPROVED). */
    async function approve(applicationId: string): Promise<void> {
      const res = await api(server.port).post(`/api/applications/${applicationId}/approve`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { status: string } };
      expect(body.data.status).toBe('APPROVED');
    }

    async function submit(applicationId: string) {
      return api(server.port).post(`/api/applications/${applicationId}/submit`);
    }

    it('submits through the full pipeline to SUBMITTED with a verified mock confirmation', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-sub-main',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      // ---- real preparation up to FORM_INSPECTED ------------------------
      await prepareAndWait(fixture.applicationId);
      const prisma = await getPrisma();

      // ---- answers (synthetic, human-approved) + EXPLICIT approval ------
      await answerAllRequiredQuestions(fixture.applicationId);
      await approve(fixture.applicationId);

      // ---- real HTTP API (production router) ----------------------------
      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        automationRun: { id: string; applicationId: string; status: string };
        enqueued: boolean;
      };
      expect(body.automationRun.applicationId).toBe(fixture.applicationId);
      expect(body.automationRun.status).toBe('QUEUED');
      expect(body.enqueued).toBe(true);

      // ---- real BullMQ job: identifiers only, no PII ---------------------
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs).toHaveLength(1);
      expect(Object.keys(jobs[0].data ?? {}).sort()).toEqual([
        'applicationId',
        'automationRunId',
      ]);
      expect(JSON.stringify(jobs[0].data)).not.toContain(fixture.email);
      expect(JSON.stringify(jobs[0].data)).not.toContain(fixture.phone);

      // ---- real worker processes the job --------------------------------
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'submitted application',
        });
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'submission automation run',
        });
      } finally {
        await worker.close();
      }

      // ---- Application: SUBMITTED with timestamps ----------------------
      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('SUBMITTED');
      expect(application!.submittedAt).not.toBeNull();
      expect(application!.externalApplicationId).toMatch(/^mock-gh-app-\d+$/);

      // ---- AutomationRun: COMPLETED, never stuck ------------------------
      const run = await prisma.automationRun.findUnique({
        where: { applicationId: fixture.applicationId },
      });
      expect(run!.status).toBe('COMPLETED');
      expect(run!.startedAt).not.toBeNull();
      expect(run!.completedAt).not.toBeNull();
      expect(run!.completedAt!.getTime()).toBeGreaterThanOrEqual(run!.startedAt!.getTime());
      expect((run!.metadata as Record<string, unknown>).finalStatus).toBe('SUBMITTED');

      // ---- Audit events: exactly one started + one completed ------------
      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
        orderBy: { createdAt: 'asc' },
      });
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes.filter((t) => t === 'SUBMISSION_STARTED')).toHaveLength(1);
      expect(eventTypes.filter((t) => t === 'SUBMISSION_COMPLETED')).toHaveLength(1);
      expect(eventTypes).not.toContain('SUBMISSION_FAILED');
      expect(eventTypes).not.toContain('CAPTCHA_DETECTED');
      expect(eventTypes).not.toContain('SECURITY_CHALLENGE');
      expect(eventTypes).not.toContain('ERROR');

      const started = events.find((e) => e.eventType === 'SUBMISSION_STARTED')!;
      const startedMeta = started.metadata as {
        submissionAttemptId: string;
        attempt: number;
        provider: string;
      };
      expect(typeof startedMeta.submissionAttemptId).toBe('string');
      expect(startedMeta.provider).toBe('GREENHOUSE');

      const completed = events.find((e) => e.eventType === 'SUBMISSION_COMPLETED')!;
      const completedMeta = completed.metadata as {
        submissionAttemptId: string;
        confirmationId: string;
        url: string;
      };
      expect(completedMeta.submissionAttemptId).toBe(startedMeta.submissionAttemptId);
      expect(completedMeta.confirmationId).toBe(application!.externalApplicationId);
      // Result/URL info is persisted safely (no query strings, no secrets).
      expect(completedMeta.url.replace(/\/$/, '')).toBe(greenhouse.url);

      // ---- No candidate PII anywhere in the audit trail -----------------
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(fixture.email);
      expect(serialized).not.toContain(fixture.phone);
      expect(serialized.toLowerCase()).not.toContain('phase14 e2e candidate');

      // ---- The mock ATS received exactly one submission -----------------
      const mySubmissions = greenhouse.submissions.slice(submissionsBefore);
      expect(mySubmissions).toHaveLength(1);
      const submission = mySubmissions[0] as {
        accepted: boolean;
        confirmationId: string;
        body: string;
      };
      expect(submission.accepted).toBe(true);
      expect(submission.confirmationId).toBe(application!.externalApplicationId);
      // The submission envelope carries identifiers and counts only.
      const envelope = JSON.parse(submission.body) as Record<string, unknown>;
      expect(envelope.kind).toBe('MOCK_SUBMISSION');
      expect(envelope.applicationId).toBe(fixture.applicationId);
      expect(envelope.submissionAttemptId).toBe(startedMeta.submissionAttemptId);
      expect(Object.keys(envelope).sort()).toEqual([
        'applicationId',
        'fieldCount',
        'kind',
        'provider',
        'requiredAnswerCount',
        'submissionAttemptId',
      ]);
      expect(submission.body).not.toContain(fixture.email);
      expect(submission.body).not.toContain(fixture.phone);

      // ---- Safe API boundary -------------------------------------------
      const statusRes = await api(server.port).get(
        `/api/applications/${fixture.applicationId}/automation`
      );
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as {
        automationRun: Record<string, unknown>;
      };
      expect(statusBody.automationRun.status).toBe('COMPLETED');
      expect(statusBody.automationRun).not.toHaveProperty('metadata');
    });

    it('is idempotent for duplicate submit requests: one job, one submission', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-sub-idem',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      await answerAllRequiredQuestions(fixture.applicationId);
      await approve(fixture.applicationId);

      // Duplicate + concurrent requests: the database-level run claim
      // collapses them into exactly one effective submission job.
      const [first, second] = await Promise.all([
        submit(fixture.applicationId),
        submit(fixture.applicationId),
      ]);
      expect([first.status, second.status].every((s) => s === 202 || s === 200)).toBe(true);
      const third = await submit(fixture.applicationId);
      expect([200, 202]).toContain(third.status);

      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs).toHaveLength(1);

      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'idempotent submission',
        });
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();
      expect(
        await prisma.automationRun.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(1);
      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      // One logical submission despite three API requests.
      expect(events.filter((e) => e.eventType === 'SUBMISSION_STARTED')).toHaveLength(1);
      expect(events.filter((e) => e.eventType === 'SUBMISSION_COMPLETED')).toHaveLength(1);
      const mySubmissions = greenhouse.submissions.slice(submissionsBefore);
      expect(mySubmissions).toHaveLength(1);
      expect(mySubmissions.filter((s) => s.accepted)).toHaveLength(1);
    });

    it('a second submission after SUBMITTED is a no-op: the mock submission count stays 1', async () => {
      const submissionsBefore = greenhouse.submissions.length;
      const fixture = await createApplicationFixture({
        prefix: 'gh-sub-twice',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      await answerAllRequiredQuestions(fixture.applicationId);
      await approve(fixture.applicationId);

      expect((await submit(fixture.applicationId)).status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'first submission',
        });
      } finally {
        await worker.close();
      }
      expect(greenhouse.submissions.slice(submissionsBefore)).toHaveLength(1);

      // A second submission attempt must NOT submit again.
      const again = await submit(fixture.applicationId);
      expect(again.status).toBe(200);
      const body = (await again.json()) as { alreadySubmitted: boolean };
      expect(body.alreadySubmitted).toBe(true);

      // Nothing new was queued and nothing new was submitted.
      expect(await submissionJobsFor(fixture.applicationId)).toHaveLength(1);
      const mySubmissions = greenhouse.submissions.slice(submissionsBefore);
      expect(mySubmissions).toHaveLength(1);
      expect(mySubmissions.filter((s) => s.accepted)).toHaveLength(1);

      const prisma = await getPrisma();
      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      expect(events.filter((e) => e.eventType === 'SUBMISSION_STARTED')).toHaveLength(1);
      expect(events.filter((e) => e.eventType === 'SUBMISSION_COMPLETED')).toHaveLength(1);
    });
  }
);
