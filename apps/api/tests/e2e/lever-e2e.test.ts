/**
 * Phase 14 - Lever end-to-end test.
 *
 * The ENTIRE production path is real (Express router -> BullMQ -> worker ->
 * @jaa/core -> ATS registry -> Lever adapter -> @jaa/browser); the only mock
 * is the loopback Lever HTTP server (bound to 127.0.0.2 so the shared
 * first-match ATS registry can tell it apart from the Greenhouse mock).
 *
 * The mock Lever apply page is a full-fidelity form (including an hCaptcha
 * placeholder and a submit button). Nothing is ever submitted: the mock
 * server records every POST and the lifecycle provably stops at
 * FORM_INSPECTED.
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
  waitForRun,
  waitForApplication,
  closeBrowserQuietly,
  LEVER_BOARD_HOST,
  type ApiServer,
  type ApplicationFixture,
} from './e2e-helpers';
import {
  startMockLeverServer,
  type MockLeverServer,
} from '../../packages/lever/tests/fixtures/mock-lever-server';

// E2E needs BOTH PostgreSQL and Redis; skip honestly when either is down.
const HAS_DB = await hasDatabase();
const HAS_REDIS = await hasRedis();

describe.skipIf(!HAS_DB || !HAS_REDIS)(
  'Phase 14 E2E: Lever (real API -> queue -> worker -> adapter -> mock ATS)',
  () => {
    let lever: MockLeverServer;
    let server: ApiServer;
    const fixtures: ApplicationFixture[] = [];

    beforeAll(async () => {
      lever = await startMockLeverServer(LEVER_BOARD_HOST);
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
      await lever?.close().catch(() => undefined);
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
        prefix: 'lv-e2e-main',
        ats: 'LEVER',
        applicationUrl: lever.url,
      });
      fixtures.push(fixture);

      // ---- real HTTP API (production router) -----------------------------
      const body = await prepare(fixture.applicationId);
      expect(body.automationRun.applicationId).toBe(fixture.applicationId);
      expect(body.automationRun.provider).toBe('LEVER');
      expect(body.automationRun.status).toBe('QUEUED');

      // ---- real BullMQ job: identifiers only, no PII ---------------------
      const jobs = await jobsFor(fixture.applicationId);
      expect(jobs).toHaveLength(1);
      expect(Object.keys(jobs[0].data ?? {}).sort()).toEqual([
        'applicationId',
        'automationRunId',
      ]);

      // ---- real worker processes the job ---------------------------------
      const worker = await startPreparationWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'lever automation run',
        });
        await waitForApplication(fixture.applicationId, (app) => app.status === 'FORM_INSPECTED', {
          label: 'lever application',
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
      expect(run!.provider).toBe('LEVER');
      expect(run!.status).toBe('COMPLETED');
      expect(run!.startedAt).not.toBeNull();
      expect(run!.completedAt).not.toBeNull();
      expect(
        String((run!.metadata as Record<string, unknown>).lastUrl).replace(/\/$/, '')
      ).toBe(lever.url);

      // ---- Application: FORM_INSPECTED, never submitted ------------------
      const application = await prisma.application.findUnique({
        where: { id: fixture.applicationId },
      });
      expect(application!.status).toBe('FORM_INSPECTED');
      expect(application!.submittedAt).toBeNull();

      // ---- Questions: exact inspection results, no fabrication -----------
      const questions = await prisma.applicationQuestion.findMany({
        where: { applicationId: fixture.applicationId },
      });
      expect(questions).toHaveLength(17);
      expect(questions.filter((q) => q.required)).toHaveLength(8);
      const types = new Set(questions.map((q) => q.fieldType));
      for (const t of [
        'TEXT',
        'EMAIL',
        'PHONE',
        'TEXTAREA',
        'SELECT',
        'RADIO',
        'CHECKBOX',
        'FILE',
      ]) {
        expect(types).toContain(t);
      }
      const byExternalId = new Map(questions.map((q) => [q.externalFieldId, q]));

      const email = byExternalId.get('email');
      expect(email?.fieldType).toBe('EMAIL');
      expect(email?.locator).toMatchObject({
        cssSelector: '[name="email"]',
        attributes: { 'data-qa': 'email-input', semantic: 'email' },
      });

      const workAuth = byExternalId.get('cards[1c719ca9-0000-0000-0000-000000000002][field0]');
      expect(workAuth?.fieldType).toBe('RADIO');
      expect(workAuth?.options).toEqual([
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ]);
      expect(workAuth?.locator).toMatchObject({
        attributes: { semantic: 'work_authorization' },
      });
      expect(workAuth?.section).toBe('Work Authorization');

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
      expect(meta.fieldCount).toBe(17);

      // The apply page carries an hCaptcha widget: it must be DETECTED and
      // REPORTED as a warning - and never solved, skipped, or bypassed.
      expect(meta.warnings.some((w) => /captcha/i.test(w))).toBe(true);
      expect(meta.warnings.some((w) => /never (bypassed|solved)/i.test(w))).toBe(true);

      // ---- No candidate PII anywhere in the audit trail ------------------
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(fixture.email);
      expect(serialized).not.toContain(fixture.phone);

      // ---- Proof of no submission ---------------------------------------
      expect(lever.submissions).toHaveLength(0);
      expect(lever.requests.every((r) => r.method === 'GET')).toBe(true);
      expect(lever.requests.some((r) => r.path === '/submit-application')).toBe(false);
    });

    it('is idempotent for duplicate prepare requests: one run, one job, one logical preparation', async () => {
      const fixture = await createApplicationFixture({
        prefix: 'lv-e2e-idem',
        ats: 'LEVER',
        applicationUrl: lever.url,
      });
      fixtures.push(fixture);

      const first = await prepare(fixture.applicationId);
      const second = await prepare(fixture.applicationId);
      expect(second.automationRun.id).toBe(first.automationRun.id);
      expect(await jobsFor(fixture.applicationId)).toHaveLength(1);

      const worker = await startPreparationWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'lever idempotent run',
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
      expect(events.filter((e) => e.eventType === 'FORM_OPENED')).toHaveLength(1);
      expect(events.filter((e) => e.eventType === 'FORM_INSPECTED')).toHaveLength(1);
      expect(
        await prisma.applicationQuestion.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(17);
      expect(lever.submissions).toHaveLength(0);
    });
  }
);
