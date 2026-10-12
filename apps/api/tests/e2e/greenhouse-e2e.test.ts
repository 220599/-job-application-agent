/**
 * Phase 14 - Greenhouse end-to-end test.
 *
 * The ENTIRE production path is real:
 *   real Express router (POST /api/applications/:id/prepare)
 *     -> real BullMQ queue (@jaa/core)
 *     -> real preparation worker (same wiring as apps/worker)
 *     -> real prepareApplication / eligibility / idempotent AutomationRun
 *     -> real ATS registry + Greenhouse adapter
 *     -> real @jaa/browser (Playwright behind the public API only)
 *   -> the ONLY mock is the loopback Greenhouse HTTP server.
 *
 * Nothing is ever submitted: the mock server records every POST and the
 * lifecycle provably stops at FORM_INSPECTED.
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
  'Phase 14 E2E: Greenhouse (real API -> queue -> worker -> adapter -> mock ATS)',
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
      const res = await api(server.port).post(`/api/applications/${applicationId}/prepare`);
      expect(res.status).toBe(202);
      return (await res.json()) as {
        automationRun: { id: string; applicationId: string; provider: string; status: string };
      };
    }

    it('runs the full pipeline and stops at FORM_INSPECTED without ever submitting', async () => {
      const fixture = await createApplicationFixture({
        prefix: 'gh-e2e-main',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      // ---- real HTTP API (production router) -----------------------------
      const body = await prepare(fixture.applicationId);
      expect(body.automationRun.applicationId).toBe(fixture.applicationId);
      expect(body.automationRun.provider).toBe('GREENHOUSE');
      expect(body.automationRun.status).toBe('QUEUED');

      // ---- real BullMQ job: identifiers only, no PII ---------------------
      const jobs = await jobsFor(fixture.applicationId);
      expect(jobs).toHaveLength(1);
      expect(Object.keys(jobs[0].data ?? {}).sort()).toEqual([
        'applicationId',
        'automationRunId',
      ]);
      expect(JSON.stringify(jobs[0].data)).not.toContain(fixture.email);
      expect(JSON.stringify(jobs[0].data)).not.toContain(fixture.phone);

      // ---- real worker processes the job ---------------------------------
      const worker = await startPreparationWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'greenhouse automation run',
        });
        await waitForApplication(fixture.applicationId, (app) => app.status === 'FORM_INSPECTED', {
          label: 'greenhouse application',
        });
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();

      // ---- AutomationRun: one row, real timestamps ----------------------
      const run = await prisma.automationRun.findUnique({
        where: { applicationId: fixture.applicationId },
      });
      expect(run).not.toBeNull();
      expect(run!.id).toBe(body.automationRun.id);
      expect(run!.applicationId).toBe(fixture.applicationId);
      expect(run!.provider).toBe('GREENHOUSE');
      expect(run!.status).toBe('COMPLETED');
      expect(run!.startedAt).not.toBeNull();
      expect(run!.completedAt).not.toBeNull();
      expect(run!.completedAt!.getTime()).toBeGreaterThanOrEqual(run!.startedAt!.getTime());
      expect(
        String((run!.metadata as Record<string, unknown>).lastUrl).replace(/\/$/, '')
      ).toBe(greenhouse.url);

      // ---- Application: FORM_INSPECTED, never submitted ------------------
      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('FORM_INSPECTED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.lastAttemptAt).not.toBeNull();

      // ---- Questions: exact inspection results, no fabrication -----------
      const questions = await prisma.applicationQuestion.findMany({
        where: { applicationId: fixture.applicationId },
      });
      expect(questions).toHaveLength(16);
      expect(questions.filter((q) => q.required)).toHaveLength(10);
      const types = new Set(questions.map((q) => q.fieldType));
      for (const t of ['TEXT', 'EMAIL', 'PHONE', 'TEXTAREA', 'SELECT', 'FILE']) {
        expect(types).toContain(t);
      }
      const byExternalId = new Map(questions.map((q) => [q.externalFieldId, q]));

      const first = byExternalId.get('first_name');
      expect(first?.label).toBe('First Name');
      expect(first?.normalizedLabel).toBe('first_name');
      expect(first?.locator).toMatchObject({
        cssSelector: '#first_name',
        attributes: { id: 'first_name', semantic: 'first_name' },
      });

      const email = byExternalId.get('email');
      expect(email?.fieldType).toBe('EMAIL');

      const workAuth = byExternalId.get('question_70000004');
      expect(workAuth?.fieldType).toBe('SELECT');
      expect(workAuth?.required).toBe(true);
      expect(workAuth?.options).toEqual([
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ]);
      expect(workAuth?.section).toBe('Additional Information');

      const linkedin = byExternalId.get('question_70000001');
      expect(linkedin?.label).toBe('LinkedIn Profile');
      expect(linkedin?.section).toBe('Additional Information');
      expect(
        (linkedin?.locator as { attributes?: { semantic?: string } })?.attributes?.semantic
      ).toBe('linkedin');

      const gender = byExternalId.get('gender');
      expect(gender?.section).toBe('Voluntary Self-Identification');

      // ---- Audit events: inspection recorded, submission never started ---
      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
        orderBy: { createdAt: 'asc' },
      });
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes.filter((t) => t === 'FORM_OPENED')).toHaveLength(1);
      expect(eventTypes.filter((t) => t === 'FORM_INSPECTED')).toHaveLength(1);
      expect(eventTypes).not.toContain('SUBMISSION_STARTED');
      expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');
      expect(eventTypes).not.toContain('SUBMISSION_FAILED');
      expect(eventTypes).not.toContain('ERROR');

      const inspected = events.find((e) => e.eventType === 'FORM_INSPECTED')!;
      const meta = inspected.metadata as {
        fieldCount: number;
        isApplicationForm: boolean;
        warnings: string[];
      };
      expect(meta.isApplicationForm).toBe(true);
      expect(meta.fieldCount).toBe(16);
      expect(Array.isArray(meta.warnings)).toBe(true);

      // ---- No candidate PII anywhere in the audit trail ------------------
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(fixture.email);
      expect(serialized).not.toContain(fixture.phone);
      expect(serialized.toLowerCase()).not.toContain('phase14 e2e candidate');

      // ---- Proof of no submission ---------------------------------------
      expect(greenhouse.submissions).toHaveLength(0);
      expect(greenhouse.requests.every((r) => r.method === 'GET')).toBe(true);
      expect(greenhouse.requests.some((r) => r.path === '/submit-application')).toBe(false);

      // ---- Safe API boundary: run internals never cross the API ----------
      const statusRes = await api(server.port).get(
        `/api/applications/${fixture.applicationId}/automation`
      );
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as {
        automationRun: Record<string, unknown>;
      };
      expect(statusBody.automationRun.status).toBe('COMPLETED');
      expect(statusBody.automationRun.applicationId).toBe(fixture.applicationId);
      expect(statusBody.automationRun).not.toHaveProperty('metadata');
    });

    it('is idempotent for duplicate prepare requests: one run, one job, one logical preparation', async () => {
      const fixture = await createApplicationFixture({
        prefix: 'gh-e2e-idem',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      const first = await prepare(fixture.applicationId);
      // Second request while the run is still QUEUED: the same run is reused
      // as-is and nothing is enqueued again.
      const second = await prepare(fixture.applicationId);
      expect(second.automationRun.id).toBe(first.automationRun.id);

      const jobs = await jobsFor(fixture.applicationId);
      expect(jobs).toHaveLength(1);

      const worker = await startPreparationWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'idempotent run',
        });
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();
      // Exactly one run row (applicationId @unique) and one logical prep.
      expect(
        await prisma.automationRun.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(1);
      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      expect(events.filter((e) => e.eventType === 'FORM_OPENED')).toHaveLength(1);
      expect(events.filter((e) => e.eventType === 'FORM_INSPECTED')).toHaveLength(1);
      expect(
        await prisma.applicationQuestion.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(16);
      expect(greenhouse.submissions).toHaveLength(0);
    });

    it('a duplicated BullMQ job is skipped, never a second logical preparation', async () => {
      const fixture = await createApplicationFixture({
        prefix: 'gh-e2e-dup',
        ats: 'GREENHOUSE',
        applicationUrl: greenhouse.url,
      });
      fixtures.push(fixture);

      await prepare(fixture.applicationId);
      const jobs = await jobsFor(fixture.applicationId);
      expect(jobs).toHaveLength(1);

      // Simulate a producer retry that duplicated the enqueue: identical
      // identifiers-only payload, second job on the same queue.
      const { getPreparationQueue, PREPARATION_JOB_OPTIONS } = await import('@jaa/core');
      await getPreparationQueue().add(
        'prepare-application',
        jobs[0].data as { applicationId: string; automationRunId: string },
        PREPARATION_JOB_OPTIONS
      );
      expect(await jobsFor(fixture.applicationId)).toHaveLength(2);

      const worker = await startPreparationWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'duplicated-job run',
        });
        // Let the duplicate job drain too (it must be SKIPPED, side-effect free).
        await waitFor(
          async () => {
            const drained = await jobsFor(fixture.applicationId);
            return drained.every((j) => (j.attemptsMade ?? 0) >= 1) ? true : null;
          },
          { label: 'duplicate job drained' }
        );
      } finally {
        await worker.close();
      }

      const prisma = await getPrisma();
      const events = await prisma.applicationEvent.findMany({
        where: { applicationId: fixture.applicationId },
      });
      // One logical preparation despite two jobs.
      expect(events.filter((e) => e.eventType === 'FORM_OPENED')).toHaveLength(1);
      expect(events.filter((e) => e.eventType === 'FORM_INSPECTED')).toHaveLength(1);
      expect(
        await prisma.applicationQuestion.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(16);
      const run = await prisma.automationRun.findUnique({
        where: { applicationId: fixture.applicationId },
      });
      expect(run!.status).toBe('COMPLETED');
      expect(greenhouse.submissions).toHaveLength(0);
    });
  }
);
