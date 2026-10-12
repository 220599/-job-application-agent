/**
 * Phase 15A - Lever mock submission end-to-end test.
 *
 * The ENTIRE production path is real (Express router -> BullMQ submission
 * queue -> worker -> submission gate/ledger -> real Lever adapter ->
 * @jaa/browser); the ONLY mock is the loopback Lever HTTP server. The happy
 * path uses the captcha-free form fixture (`/no-captcha`); the CAPTCHA case
 * proves that the real apply page's hCaptcha stops submission and is never
 * solved or bypassed.
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
  startMockLeverServer,
  type MockLeverServer,
} from '../../packages/lever/tests/fixtures/mock-lever-server';
import { LEVER_BOARD_HOST } from './e2e-helpers';

// E2E needs BOTH PostgreSQL and Redis; skip honestly when either is down.
const HAS_DB = await hasDatabase();
const HAS_REDIS = await hasRedis();

describe.skipIf(!HAS_DB || !HAS_REDIS)(
  'Phase 15A E2E: Lever mock submission (real API -> queue -> worker -> adapter -> mock ATS)',
  () => {
    let lever: MockLeverServer;
    let server: ApiServer;
    const fixtures: ApplicationFixture[] = [];

    beforeAll(async () => {
      lever = await startMockLeverServer(LEVER_BOARD_HOST);
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
      await lever?.close().catch(() => undefined);
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
          label: 'lever preparation run',
        });
        await waitForApplication(applicationId, (app) => app.status === 'FORM_INSPECTED', {
          label: 'lever prepared application',
        });
      } finally {
        await worker.close();
      }
    }

    async function approve(applicationId: string): Promise<void> {
      const res = await api(server.port).post(`/api/applications/${applicationId}/approve`);
      expect(res.status).toBe(200);
    }

    it('submits through the full pipeline to SUBMITTED with a verified mock confirmation', async () => {
      const submissionsBefore = lever.submissions.length;
      const fixture = await createApplicationFixture({
        prefix: 'lv-sub-main',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/no-captcha`,
      });
      fixtures.push(fixture);

      await prepareAndWait(fixture.applicationId);
      const prisma = await getPrisma();

      await answerAllRequiredQuestions(fixture.applicationId);
      await approve(fixture.applicationId);

      const res = await api(server.port).post(`/api/applications/${fixture.applicationId}/submit`);
      expect(res.status).toBe(202);

      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs).toHaveLength(1);
      expect(Object.keys(jobs[0].data ?? {}).sort()).toEqual([
        'applicationId',
        'automationRunId',
      ]);
      expect(JSON.stringify(jobs[0].data)).not.toContain(fixture.email);
      expect(JSON.stringify(jobs[0].data)).not.toContain(fixture.phone);

      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'lever submitted application',
        });
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'lever submission run',
        });
      } finally {
        await worker.close();
      }

      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('SUBMITTED');
      expect(application!.submittedAt).not.toBeNull();
      expect(application!.externalApplicationId).toMatch(/^mock-lever-app-\d+$/);

      const run = await prisma.automationRun.findUnique({
        where: { applicationId: fixture.applicationId },
      });
      expect(run!.status).toBe('COMPLETED');
      expect(run!.completedAt).not.toBeNull();
      expect((run!.metadata as Record<string, unknown>).finalStatus).toBe('SUBMITTED');

      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
        orderBy: { createdAt: 'asc' },
      });
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes.filter((t) => t === 'SUBMISSION_STARTED')).toHaveLength(1);
      expect(eventTypes.filter((t) => t === 'SUBMISSION_COMPLETED')).toHaveLength(1);
      expect(eventTypes).not.toContain('SUBMISSION_FAILED');
      expect(eventTypes).not.toContain('ERROR');

      const completed = events.find((e) => e.eventType === 'SUBMISSION_COMPLETED')!;
      const completedMeta = completed.metadata as {
        confirmationId: string;
        url: string;
      };
      expect(completedMeta.confirmationId).toBe(application!.externalApplicationId);

      // No candidate PII anywhere in the audit trail.
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(fixture.email);
      expect(serialized).not.toContain(fixture.phone);

      // The mock ATS received exactly one identifiers-only submission.
      const mySubmissions = lever.submissions.slice(submissionsBefore);
      expect(mySubmissions).toHaveLength(1);
      const submission = mySubmissions[0] as {
        accepted: boolean;
        confirmationId: string;
        body: string;
      };
      expect(submission.accepted).toBe(true);
      expect(submission.confirmationId).toBe(application!.externalApplicationId);
      expect(submission.body).not.toContain(fixture.email);
      expect(submission.body).not.toContain(fixture.phone);
    });

    it('detects the real apply page hCaptcha and stops without ever submitting', async () => {
      const submissionsBefore = lever.submissions.length;
      const requestsBefore = lever.requests.length;
      const fixture = await createApplicationFixture({
        prefix: 'lv-sub-captcha',
        ats: 'LEVER',
        applicationUrl: lever.url,
      });
      fixtures.push(fixture);

      // The real Lever apply page carries an hCaptcha placeholder.
      await prepareAndWait(fixture.applicationId);
      await answerAllRequiredQuestions(fixture.applicationId);
      await approve(fixture.applicationId);

      const res = await api(server.port).post(`/api/applications/${fixture.applicationId}/submit`);
      expect(res.status).toBe(202);

      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'lever captcha run',
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
      expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');

      // Never solved, never bypassed: zero submissions, only GET page loads.
      expect(lever.submissions.slice(submissionsBefore)).toHaveLength(0);
      expect(lever.requests.slice(requestsBefore).every((r) => r.method === 'GET')).toBe(true);
    });
  }
);
