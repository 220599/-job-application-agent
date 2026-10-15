/**
 * Phase 15C - Lever Apply API submission end-to-end tests.
 *
 * The ENTIRE production path is real:
 *   real Express router (POST /api/applications/:id/approve + /submit)
 *     -> real BullMQ submission queue (@jaa/core)
 *     -> real submission worker (same wiring as apps/worker)
 *     -> real submission gate / attempt ledger / AutomationRun lifecycle
 *     -> real ATS registry + Lever adapter (submitApplication)
 *     -> real documented Apply API client (packages/lever)
 *   -> the ONLY mocks are the loopback mock Lever form server (DOM prep /
 *      browser fallback) and the loopback mock Lever API server.
 *
 * Every scenario proves one contract of the documented, employer-authorized
 * Apply API path (hire.lever.co/developer/documentation):
 *
 *   1. success carries the DOCUMENTED provider evidence (201 +
 *      data.applicationId -> PROVIDER_ID) - persisted with transport/
 *      warnings, PII-free events, and the documented resume upload uri;
 *   2-3. a 2xx WITHOUT the documented application id is NEVER accepted -
 *      the outcome is UNKNOWN, nothing is retried, no id is invented;
 *   4. an explicit provider refusal (4xx) is a definitive failure with
 *      exactly ONE request;
 *   5. credential refusals (401/403) are reported precisely and the key is
 *      never leaked anywhere;
 *   6-7. missing required answers, ungroundable documented questions, and
 *      unsupported resume files block BEFORE any request is sent - never
 *      fabricated;
 *   8. a connection-refused request is a definitive PRE-TRANSMISSION
 *      failure ("never transmitted");
 *   9. a crash after the API submission can never cause a second
 *      submission - the worker retry AND a fresh job both refuse;
 *   10. duplicate submit requests and duplicate queue jobs collapse into
 *      exactly one submission (idempotency proof);
 *   11. the browser fallback is never silent: the reason is recorded;
 *   12. REAL/unsafe targets are refused fail-closed even with an employer
 *      key configured (no live submissions, ever);
 *   13. CAPTCHA challenges stop the fallback path and are never solved, and
 *      the HTTP surface reports every outcome honestly.
 *
 * All candidate data is synthetic (test.invalid emails, 555-01xx phones).
 * The employer API key never appears in events, run metadata, queue
 * payloads, or error messages.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

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
  LEVER_BOARD_HOST,
  type ApiServer,
  type ApplicationFixture,
} from './e2e-helpers';
import {
  startMockLeverServer,
  type MockLeverServer,
} from '../../packages/lever/tests/fixtures/mock-lever-server';
import {
  startMockLeverApiServer,
  type MockLeverApiServer,
  type MockLeverApiSchema,
} from '../../packages/lever/tests/fixtures/mock-lever-api';
import { ORCHESTRATION_ERROR_STATUS } from '../../src/routes/applications';

// E2E needs BOTH PostgreSQL and Redis; skip honestly when either is down.
const HAS_DB = await hasDatabase();
const HAS_REDIS = await hasRedis();

/** The employer-issued key the mock Lever API provider requires. */
const MOCK_API_KEY = 'test-lever-api-key';
/** A WRONG configured key (scenario 5) - must never leak into any artifact. */
const WRONG_API_KEY = 'wrong-employer-key-DO-NOT-LEAK-8d21';
const RESUME_CONTENT = 'Synthetic approved resume content. Not a real candidate document.\n';
const POSTING_ID = '250d8f03-738a-4bba-a671-8a3d73477145';

/**
 * Documented question schema ("Retrieve posting application questions")
 * for the mock Lever API provider. Labels match the mock Lever DOM form
 * exactly so the label/semantic mapping is exercised end to end.
 */
const E2E_SCHEMA: MockLeverApiSchema = {
  personalInformation: [
    { name: 'fullName', text: 'Full name', type: 'text', required: true },
    { name: 'email', text: 'Email', type: 'text', required: true },
    { name: 'phone', text: 'Phone', type: 'text', required: false },
    { name: 'currentCompany', text: 'Current company', type: 'text', required: false },
    { name: 'resume', text: 'Resume/CV', type: 'file-upload', required: false },
    {
      name: 'additionalInformation',
      text: 'Additional information',
      type: 'textarea',
      required: false,
    },
  ],
  urls: [
    { name: 'LinkedIn', text: 'LinkedIn URL', type: 'text', required: false },
    { name: 'Github', text: 'GitHub URL', type: 'text', required: false },
    { name: 'Other Website', text: 'Portfolio URL', type: 'text', required: false },
  ],
  customQuestions: [
    {
      id: 'set-supplementary',
      text: 'Supplementary Questions',
      fields: [
        {
          id: 'f-languages',
          text: 'Language Skill(s) (Check all that apply)',
          type: 'multiple-select',
          required: true,
          options: [
            { text: 'English (ENG)', optionId: 'English (ENG)' },
            { text: 'Spanish (SPA)', optionId: 'Spanish (SPA)' },
            { text: 'French (FRA)', optionId: 'French (FRA)' },
          ],
        },
        {
          id: 'f-preferred',
          text: 'Preferred Name | What would you like us to call you?',
          type: 'text',
          required: false,
        },
      ],
    },
    {
      id: 'set-work-auth',
      text: 'Work Authorization',
      fields: [
        {
          id: 'f-auth',
          text: 'Are you legally authorized to work in the country for which you are applying?',
          type: 'multiple-choice',
          required: true,
          options: [
            { text: 'Yes', optionId: 'Yes' },
            { text: 'No', optionId: 'No' },
          ],
        },
        {
          id: 'f-sponsorship',
          text: 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B, etc.)?',
          type: 'multiple-choice',
          required: true,
          options: [
            { text: 'Yes', optionId: 'Yes' },
            { text: 'No', optionId: 'No' },
          ],
        },
      ],
    },
    {
      id: 'set-university',
      text: 'University',
      fields: [
        {
          id: 'f-university',
          text: 'Which university are you currently attending or did you last attend?',
          type: 'university',
          required: true,
          options: [
            { text: 'Aalborg University', optionId: 'Aalborg University' },
            { text: 'Aalto University', optionId: 'Aalto University' },
            { text: 'Other (School Not Listed)', optionId: 'Other (School Not Listed)' },
          ],
        },
      ],
    },
    {
      id: 'set-additional',
      text: 'Additional Questions',
      fields: [
        {
          id: 'f-favorite',
          text: 'What has been your favorite project or proudest accomplishment? Why?',
          type: 'textarea',
          required: false,
        },
      ],
    },
  ],
  eeoQuestions: {},
};

/**
 * Scenario 6: a documented required question that NO prepared answer can
 * ever ground (its label exists nowhere in the inspected form). The
 * client-side required validation must block before sending - never guess.
 */
const STRICT_SCHEMA: MockLeverApiSchema = {
  ...E2E_SCHEMA,
  customQuestions: [
    ...E2E_SCHEMA.customQuestions,
    {
      id: 'set-strict',
      text: 'Strict Screening',
      fields: [
        {
          id: 'f-kubernetes',
          text: 'How many years of Kubernetes experience do you have?',
          type: 'text',
          required: true,
        },
      ],
    },
  ],
};

describe.skipIf(!HAS_DB || !HAS_REDIS)(
  'Phase 15C E2E: Lever Apply API submission (real API -> queue -> worker -> client -> mock provider)',
  () => {
    /** The loopback mock Lever application form (DOM prep / fallback). */
    let lever: MockLeverServer;
    /** The mock Lever API provider (behavior switchable per test). */
    let leverApi: MockLeverApiServer;
    /** Provider with one extra unanswerable required question (scenario 6). */
    let strictLeverApi: MockLeverApiServer;
    /** Provider that dies after the resume upload (scenario 8). */
    let closingLeverApi: MockLeverApiServer;
    let server: ApiServer;
    const fixtures: ApplicationFixture[] = [];

    beforeAll(async () => {
      lever = await startMockLeverServer(LEVER_BOARD_HOST);
      leverApi = await startMockLeverApiServer({ apiKey: MOCK_API_KEY, schema: E2E_SCHEMA });
      strictLeverApi = await startMockLeverApiServer({
        apiKey: MOCK_API_KEY,
        schema: STRICT_SCHEMA,
      });
      closingLeverApi = await startMockLeverApiServer({
        apiKey: MOCK_API_KEY,
        schema: E2E_SCHEMA,
        closeAfterUpload: true,
      });
      server = await startApiServer();
      await resetPreparationQueue();
      await resetSubmissionQueue();
    });

    afterAll(async () => {
      clearLeverEnv();
      for (const fixture of fixtures) {
        await cleanupFixture(fixture).catch(() => undefined);
      }
      await resetPreparationQueue().catch(() => undefined);
      await resetSubmissionQueue().catch(() => undefined);
      await closeBrowserQuietly();
      await server?.close().catch(() => undefined);
      await lever?.close().catch(() => undefined);
      await leverApi?.close().catch(() => undefined);
      await strictLeverApi?.close().catch(() => undefined);
      await closingLeverApi?.close().catch(() => undefined);
      await (await getPrisma()).$disconnect().catch(() => undefined);
    });

    beforeEach(async () => {
      clearLeverEnv();
      leverApi.setBehavior('ok');
      // Fresh provider-observation state per test: assertions below prove
      // EXACT request counts for THIS test alone.
      leverApi.reset();
      strictLeverApi.reset();
      closingLeverApi.reset();
      await resetPreparationQueue();
      await resetSubmissionQueue();
    });

    afterEach(() => {
      clearLeverEnv();
    });

    // ------------------------------------------------------------------
    // Environment seams (server-side path selection, read at submit time)
    // ------------------------------------------------------------------

    function clearLeverEnv(): void {
      delete process.env.JAA_LEVER_API_KEY;
      delete process.env.JAA_LEVER_API_BASE;
    }

    function setLeverEnv(apiKey: string, baseUrl?: string): void {
      process.env.JAA_LEVER_API_KEY = apiKey;
      if (baseUrl) {
        process.env.JAA_LEVER_API_BASE = baseUrl;
      } else {
        delete process.env.JAA_LEVER_API_BASE;
      }
    }

    // ------------------------------------------------------------------
    // Pipeline helpers (same proven pattern as the Greenhouse suites)
    // ------------------------------------------------------------------

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

    async function submit(applicationId: string) {
      return api(server.port).post(`/api/applications/${applicationId}/submit`);
    }

    /**
     * Answer every required question with a synthetic answer, give the
     * Email question a syntactically valid synthetic address (the
     * documented API validates it), then take the explicit human approval.
     */
    async function answerAndApprove(
      fixture: ApplicationFixture,
      options: { skipQuestionIds?: string[] } = {}
    ): Promise<void> {
      await answerAllRequiredQuestions(fixture.applicationId, options);
      if (await findQuestion(fixture.applicationId, 'Email')) {
        await setAnswer(fixture.applicationId, 'Email', fixture.email);
      }
      await approve(fixture.applicationId);
    }

    const normLabel = (label: string): string =>
      label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

    /** Find a prepared question by label (asterisks/spacing ignored). */
    async function findQuestion(applicationId: string, label: string) {
      const prisma = await getPrisma();
      const questions = await prisma.applicationQuestion.findMany({ where: { applicationId } });
      return questions.find((q) => normLabel(q.label) === normLabel(label)) ?? null;
    }

    /** Set (or replace) one approved synthetic answer by question label. */
    async function setAnswer(
      applicationId: string,
      label: string,
      value: string
    ): Promise<void> {
      const prisma = await getPrisma();
      const question = await findQuestion(applicationId, label);
      if (!question) throw new Error(`No prepared question with label "${label}"`);
      const updated = await prisma.applicationAnswer.updateMany({
        where: { questionId: question.id },
        data: { answer: value },
      });
      if (updated.count === 0) {
        await prisma.applicationAnswer.create({
          data: {
            questionId: question.id,
            answer: value,
            source: 'USER_INPUT',
            confidence: 1,
            groundedFacts: [],
            needsReview: false,
            approved: true,
            generatedAt: new Date(),
          },
        });
      }
    }

    /**
     * Point the approved resume version at a REAL file on disk - the Apply
     * API path reads the approved file for the documented upload endpoint
     * (nothing else in the pipeline reads it).
     */
    async function attachRealResume(
      fixture: ApplicationFixture,
      fileName: string,
      content: string
    ): Promise<string> {
      const dir = path.join(os.tmpdir(), 'jaa-e2e-lever-api');
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${fixture.userId}-${fileName}`);
      await fs.writeFile(filePath, content);
      const prisma = await getPrisma();
      await prisma.resumeVersion.update({
        where: { id: fixture.resumeVersionId },
        data: { filePath },
      });
      return filePath;
    }

    async function eventsFor(applicationId: string) {
      const prisma = await getPrisma();
      return prisma.applicationEvent.findMany({
        where: { applicationId },
        orderBy: { createdAt: 'asc' },
      });
    }

    async function applicationFor(applicationId: string) {
      const prisma = await getPrisma();
      return prisma.application.findUnique({ where: { id: applicationId } });
    }

    async function runFor(applicationId: string) {
      const prisma = await getPrisma();
      return prisma.automationRun.findUnique({ where: { applicationId } });
    }

    /** Count of application POST requests seen by the mock provider. */
    function applyPosts(apiServer: MockLeverApiServer): number {
      return apiServer.requests.filter(
        (r) => r.method === 'POST' && /^\/v1\/postings\/[^/]+\/apply$/.test(r.path)
      ).length;
    }

    /** Assert a refused request queued nothing and submitted nothing. */
    async function assertNothingRan(
      applicationId: string,
      counts: { form: number; api: number }
    ): Promise<void> {
      expect(await submissionJobsFor(applicationId)).toHaveLength(0);
      expect(lever.submissions.length).toBe(counts.form);
      expect(leverApi.submissions.length).toBe(counts.api);
      const application = await applicationFor(applicationId);
      expect(application!.status).not.toBe('SUBMITTED');
      expect(application!.submittedAt).toBeNull();
    }

    /** Wait until every BullMQ job for the application has been attempted. */
    async function waitForJobsSettled(
      applicationId: string,
      jobCount: number,
      label: string
    ): Promise<void> {
      await waitFor(
        async () => {
          const jobs = await submissionJobsFor(applicationId);
          return jobs.length === jobCount && jobs.every((j) => (j.attemptsMade ?? 0) >= 1)
            ? true
            : null;
        },
        { timeoutMs: 120_000, label }
      );
    }

    // ==================================================================
    // 1. Success with authoritative documented evidence (PROVIDER_ID)
    // ==================================================================

    it('1. submits through the documented Apply API with the documented application id as PROVIDER_ID evidence', async () => {
      const formSubsBefore = lever.submissions.length;
      const apiReqBefore = leverApi.requests.length;
      setLeverEnv(MOCK_API_KEY, leverApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'lever-api-main',
        ats: 'LEVER',
        // Posting-shaped application URL: the DOM prep reads the form AND
        // the API target parses the documented posting id.
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);

      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      // ---- real HTTP API (production router) --------------------------
      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        automationRun: { applicationId: string; status: string };
        enqueued: boolean;
      };
      expect(body.automationRun.applicationId).toBe(fixture.applicationId);
      expect(body.enqueued).toBe(true);

      // ---- real BullMQ job: identifiers only, no PII -------------------
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs).toHaveLength(1);
      expect(Object.keys(jobs[0].data ?? {}).sort()).toEqual([
        'applicationId',
        'automationRunId',
      ]);
      expect(JSON.stringify(jobs[0].data)).not.toContain(fixture.email);
      expect(JSON.stringify(jobs[0].data)).not.toContain(fixture.phone);

      // ---- real worker processes the job ------------------------------
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'lever api submitted application',
        });
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'lever api submission run',
        });
      } finally {
        await worker.close();
      }

      // ---- persisted state + documented request body -------------------
      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('SUBMITTED');
      expect(application!.externalApplicationId).toBe('915a6cef-4f91-4f3d-b8ff-a49e1eae2c30');

      // Exactly ONE upload + ONE application request - never retried.
      expect(leverApi.uploads).toHaveLength(1);
      expect(applyPosts(leverApi)).toBe(1);
      expect(leverApi.submissions).toHaveLength(1);
      expect(lever.submissions.slice(formSubsBefore)).toHaveLength(0);

      const sent = leverApi.submissions[0] as {
        personalInformation: { name: string; value: string }[];
        customQuestions: { id: string; fields: unknown[] }[];
      };
      const resumeValue = sent.personalInformation.find((p) => p.name === 'resume')?.value ?? '';
      expect(resumeValue).toContain('/v1/uploads/'); // the documented upload uri
      expect(resumeValue).not.toContain('Synthetic approved resume'); // never raw content
      // Documented custom question sets and field ORDER are preserved.
      expect(sent.customQuestions.map((c) => c.id)).toEqual([
        'set-supplementary',
        'set-work-auth',
        'set-university',
      ]);
      expect(sent.customQuestions.map((c) => c.fields.length)).toEqual([2, 2, 1]);

      // ---- PII-free audit trail ----------------------------------------
      const events = await eventsFor(fixture.applicationId);
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain('SUBMISSION_STARTED');
      expect(eventTypes).toContain('SUBMISSION_COMPLETED');
      const completed = events.find((e) => e.eventType === 'SUBMISSION_COMPLETED')!;
      const meta = completed.metadata as Record<string, unknown>;
      expect(meta.confirmationMethod).toBe('PROVIDER_ID');
      expect(meta.confirmationId).toBe('915a6cef-4f91-4f3d-b8ff-a49e1eae2c30');
      expect(meta.transport).toBe('API');
      expect(meta.httpStatus).toBe(201);
      expect(completed.message).not.toContain(fixture.email);
      expect(JSON.stringify(events)).not.toContain(fixture.email);
      expect(JSON.stringify(events)).not.toContain(WRONG_API_KEY);
    });

    // ==================================================================
    // 2-3. A 2xx WITHOUT the documented application id is never accepted
    // ==================================================================

    it('2. never claims SUBMITTED from a bare 2xx and never resubmits after the UNKNOWN outcome', async () => {
      leverApi.setBehavior('no-reference');
      setLeverEnv(MOCK_API_KEY, leverApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'lever-api-unknown',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      expect((await submit(fixture.applicationId)).status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(
          fixture.applicationId,
          (app) => app.errorCode === 'SUBMISSION_OUTCOME_UNKNOWN',
          { timeoutMs: 120_000, label: 'lever api unknown outcome' }
        );
        await waitForJobsSettled(fixture.applicationId, 1, 'unknown outcome job settled');
      } finally {
        await worker.close();
      }

      // The request DID land (one request) but is never claimed as success.
      expect(applyPosts(leverApi)).toBe(1);
      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.externalApplicationId).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_OUTCOME_UNKNOWN');

      // A fresh submit must NEVER transmit a second application: the API
      // itself refuses the ambiguous-outcome application up front (409,
      // SUBMISSION_OUTCOME_UNKNOWN) and no second job is ever queued.
      const res2 = await submit(fixture.applicationId);
      expect(res2.status).toBe(409);
      const body2 = (await res2.json()) as { error: { code: string } };
      expect(body2.error.code).toBe('SUBMISSION_OUTCOME_UNKNOWN');
      await waitForJobsSettled(fixture.applicationId, 1, 'no second job queued');
      expect(applyPosts(leverApi)).toBe(1); // still exactly one - ever
      const events = await eventsFor(fixture.applicationId);
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');
    });

    // ==================================================================
    // 4-5. Provider refusals are definitive; credentials never leak
    // ==================================================================

    it('3. reports an explicit provider refusal (HTTP 422) as a definitive failure with exactly one request', async () => {
      leverApi.setBehavior('reject');
      setLeverEnv(MOCK_API_KEY, leverApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'lever-api-422',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      expect((await submit(fixture.applicationId)).status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          timeoutMs: 120_000,
          label: 'lever api 422 run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, '422 job settled');
      } finally {
        await worker.close();
      }

      expect(applyPosts(leverApi)).toBe(1); // definitive refusal: never retried
      expect(leverApi.submissions).toHaveLength(0); // nothing was created
      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.errorCode).toBe('SUBMISSION_FAILED');
    });

    it('4. refuses credential failures precisely (HTTP 401) and never leaks the employer key', async () => {
      setLeverEnv(WRONG_API_KEY, leverApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'lever-api-401',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      expect((await submit(fixture.applicationId)).status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          timeoutMs: 120_000,
          label: 'lever api 401 run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, '401 job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.errorCode).toBe('SUBMISSION_FAILED');
      expect(application!.errorMessage).toMatch(/credentials|API key/i);
      expect(application!.errorMessage).not.toContain(WRONG_API_KEY);

      // The key appears NOWHERE: events, runs, queue payloads, errors.
      const events = await eventsFor(fixture.applicationId);
      expect(JSON.stringify(events)).not.toContain(WRONG_API_KEY);
      const run = await runFor(fixture.applicationId);
      expect(JSON.stringify(run)).not.toContain(WRONG_API_KEY);
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(JSON.stringify(jobs)).not.toContain(WRONG_API_KEY);
      expect(leverApi.submissions).toHaveLength(0);
    });

    // ==================================================================
    // 6-7. Pre-send validation: never fabricated, nothing transmitted
    // ==================================================================

    it('5. blocks submission before enqueueing when a required answer is missing', async () => {
      setLeverEnv(MOCK_API_KEY, leverApi.url);
      const fixture = await createApplicationFixture({
        prefix: 'lever-api-missing',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);

      const emailQuestion = await findQuestion(fixture.applicationId, 'Email');
      // Skip Email AND keep it unanswered - answerAndApprove would re-answer
      // it, so call the answer fixture + approve directly (same pattern as
      // the Greenhouse safety suite).
      await answerAllRequiredQuestions(fixture.applicationId, {
        skipQuestionIds: [emailQuestion!.id],
      });
      await approve(fixture.applicationId);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('REQUIRED_ANSWER_MISSING');
      await assertNothingRan(fixture.applicationId, {
        form: lever.submissions.length,
        api: leverApi.submissions.length,
      });
      expect(applyPosts(leverApi)).toBe(0);
    });

    it('6. blocks before sending when a documented required question has no grounded answer (never fabricated)', async () => {
      setLeverEnv(MOCK_API_KEY, strictLeverApi.url);
      const fixture = await createApplicationFixture({
        prefix: 'lever-api-strict',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      expect((await submit(fixture.applicationId)).status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          timeoutMs: 120_000,
          label: 'lever api strict run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'strict job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.errorMessage).toContain('is required by the application form');
      // NOTHING was transmitted: no upload, no application request.
      expect(strictLeverApi.uploads).toHaveLength(0);
      expect(applyPosts(strictLeverApi)).toBe(0);
    });

    it('7. blocks before sending when the approved resume type is not a documented upload format', async () => {
      setLeverEnv(MOCK_API_KEY, leverApi.url);
      const fixture = await createApplicationFixture({
        prefix: 'lever-api-bad-resume',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.exe', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      expect((await submit(fixture.applicationId)).status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          timeoutMs: 120_000,
          label: 'lever api bad resume run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'bad resume job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.errorMessage).toContain('not a documented upload format');
      expect(leverApi.uploads).toHaveLength(0); // refused BEFORE the upload
      expect(applyPosts(leverApi)).toBe(0);
    });

    // ==================================================================
    // 8. Connection failure before transmission is definitive
    // ==================================================================

    it('8. reports a connection-refused submission request as a pre-transmission failure ("never transmitted")', async () => {
      setLeverEnv(MOCK_API_KEY, closingLeverApi.url);
      const fixture = await createApplicationFixture({
        prefix: 'lever-api-never-sent',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      expect((await submit(fixture.applicationId)).status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          timeoutMs: 120_000,
          label: 'lever api never-transmitted run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'never-transmitted job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.errorMessage).toContain('never transmitted');
      // The upload landed; the application request could not connect.
      expect(closingLeverApi.uploads).toHaveLength(1);
      expect(closingLeverApi.submissions).toHaveLength(0);
    });

    // ==================================================================
    // 9. Crash after transmission -> duplicate prevention (ledger)
    // ==================================================================

    it('9. a crash after the API submission can never cause a second submission', async () => {
      setLeverEnv(MOCK_API_KEY, leverApi.url);
      const fixture = await createApplicationFixture({
        prefix: 'lever-api-crash',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      expect((await submit(fixture.applicationId)).status).toBe(202);

      // The dangerous boundary: the Apply API ACCEPTS the application,
      // then the worker "dies" before any bookkeeping. The real
      // submitApplication runs (real client -> mock provider); only the
      // process death is simulated.
      const {
        submitApplication,
        SimulatedWorkerCrash,
        findUnresolvedSubmissionAttempt,
        enqueueSubmissionJob,
      } = await import('@jaa/core');
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
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          timeoutMs: 120_000,
          label: 'crash-retry run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'crash-retry job settled');
      } finally {
        await worker.close();
      }

      // The FIRST (crashed) attempt really submitted - exactly once.
      expect(leverApi.submissions).toHaveLength(1);
      // The BullMQ retry ran but refused before touching the provider.
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(2);
      expect(applyPosts(leverApi)).toBe(1); // no second application request
      expect(leverApi.uploads).toHaveLength(1);

      // A completely fresh job must ALSO refuse while the marker is open.
      const run = await runFor(fixture.applicationId);
      await enqueueSubmissionJob({
        applicationId: fixture.applicationId,
        automationRunId: run!.id,
      });
      await closeBrowserQuietly();
      const worker2 = await startSubmissionWorker();
      try {
        await waitForJobsSettled(fixture.applicationId, 2, 'fresh job refused');
      } finally {
        await worker2.close();
      }

      // The provider still saw exactly one submission - ever.
      expect(leverApi.submissions).toHaveLength(1);
      expect(applyPosts(leverApi)).toBe(1);
      expect(await findUnresolvedSubmissionAttempt(fixture.applicationId)).not.toBeNull();

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).not.toBe('SUBMITTED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.externalApplicationId).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_OUTCOME_UNKNOWN');

      const events = await eventsFor(fixture.applicationId);
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes.filter((t) => t === 'SUBMISSION_STARTED')).toHaveLength(1);
      expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');
      expect(eventTypes).not.toContain('SUBMISSION_FAILED');
    });

    // ==================================================================
    // 10. Duplicate requests and duplicate jobs collapse to one submit
    // ==================================================================

    it('10. collapses duplicate submit requests and duplicate queue jobs into one submission', async () => {
      setLeverEnv(MOCK_API_KEY, leverApi.url);
      const fixture = await createApplicationFixture({
        prefix: 'lever-api-dedupe',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const [a, b, c] = await Promise.all([
        submit(fixture.applicationId),
        submit(fixture.applicationId),
        submit(fixture.applicationId),
      ]);
      expect([a.status, b.status, c.status].filter((s) => s === 202).length).toBeGreaterThanOrEqual(1);

      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          timeoutMs: 120_000,
          label: 'deduped submission',
        });
        await waitForJobsSettled(
          fixture.applicationId,
          (await submissionJobsFor(fixture.applicationId)).length,
          'dedupe jobs settled'
        );
      } finally {
        await worker.close();
      }

      // A later submit is refused by the state machine (already submitted).
      const third = await submit(fixture.applicationId);
      expect(third.status).not.toBe(202);

      // Exactly ONE application - ever.
      expect(leverApi.submissions).toHaveLength(1);
      expect(applyPosts(leverApi)).toBe(1);

      // And one more worker run can never create a second one.
      await closeBrowserQuietly();
      const worker2 = await startSubmissionWorker();
      try {
        await waitFor(
          async () => {
            const jobs = await submissionJobsFor(fixture.applicationId);
            return jobs.every((j) => (j.attemptsMade ?? 0) >= 1) ? true : null;
          },
          { timeoutMs: 120_000, label: 'post-dedupe jobs settled' }
        );
      } finally {
        await worker2.close();
      }
      expect(leverApi.submissions).toHaveLength(1);
    });

    // ==================================================================
    // 11. The browser fallback is never silent
    // ==================================================================

    it('11. falls back to the application form with a recorded reason when the API path is unavailable', async () => {
      const apiReqBefore = leverApi.requests.length;
      // No employer key configured -> the form path, with the reason
      // recorded in the completion event (never silent).
      const fixture = await createApplicationFixture({
        prefix: 'lever-api-fallback',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/testco/${POSTING_ID}`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      expect((await submit(fixture.applicationId)).status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          timeoutMs: 120_000,
          label: 'fallback submission',
        });
      } finally {
        await worker.close();
      }

      const events = await eventsFor(fixture.applicationId);
      const completed = events.find((e) => e.eventType === 'SUBMISSION_COMPLETED')!;
      const meta = completed.metadata as { warnings?: string[] };
      expect(JSON.stringify(meta.warnings ?? [])).toContain('JAA_LEVER_API_KEY');

      // The mock envelope carries identifiers and counts only - never PII.
      const entry = lever.submissions[lever.submissions.length - 1] as { body: string };
      const envelope = JSON.parse(entry.body) as Record<string, unknown>;
      expect(envelope.kind).toBe('MOCK_SUBMISSION');
      expect(JSON.stringify(envelope)).not.toContain(fixture.email);
      expect(JSON.stringify(envelope)).not.toContain('Synthetic approved resume');

      // The API provider was never consulted.
      expect(leverApi.requests.length).toBe(apiReqBefore);
    });

    // ==================================================================
    // 12. REAL and unsafe targets fail closed, even with a key configured
    // ==================================================================

    it('12. refuses REAL and unsafe targets fail-closed even when an employer key is configured', async () => {
      const counts = { form: lever.submissions.length, api: leverApi.submissions.length };
      const apiReqBefore = leverApi.requests.length;
      // The REAL submission capability stays OFF - no live submissions.
      expect(process.env.JAA_REAL_LEVER_SUBMISSION_ENABLED ?? '').not.toBe('true');
      setLeverEnv(MOCK_API_KEY, leverApi.url);

      const unsafeUrls: { url: string; code: string }[] = [
        // A REAL Lever posting with the documented URL shape: the employer
        // key must NOT bypass the fail-closed target policy.
        {
          url: `https://jobs.lever.co/real-company/${POSTING_ID}`,
          code: 'BLOCKED_BY_SECURITY_POLICY',
        },
        // Cloud metadata / link-local: refused outright (SSRF).
        {
          url: 'http://169.254.169.254/latest/meta-data/',
          code: 'BLOCKED_BY_SECURITY_POLICY',
        },
        // Non-http protocols are never valid application targets.
        { url: 'javascript:alert(1)', code: 'INVALID_APPLICATION_URL' },
      ];

      for (const unsafe of unsafeUrls) {
        const fixture = await createApplicationFixture({
          prefix: `lever-url-${unsafe.code.toLowerCase().replace(/_/g, '-')}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
          ats: 'LEVER',
          applicationUrl: unsafe.url,
        });
        fixtures.push(fixture);

        const res = await submit(fixture.applicationId);
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe(unsafe.code);

        await assertNothingRan(fixture.applicationId, counts);
      }

      // No provider was ever consulted - fail closed before anything runs.
      expect(leverApi.requests.length).toBe(apiReqBefore);
      expect(lever.submissions.length).toBe(counts.form);
    });

    // ==================================================================
    // 13. Challenges stop the fallback; outcomes are reported honestly
    // ==================================================================

    it('13. stops on a CAPTCHA in the fallback path and reports every outcome honestly', async () => {
      const formSubsBefore = lever.submissions.length;
      setLeverEnv(MOCK_API_KEY, leverApi.url);

      // The root page carries the hCaptcha placeholder; a non-posting-
      // shaped URL runs the form path - where the CAPTCHA policy is
      // unchanged: detected, never solved, never bypassed.
      const fixture = await createApplicationFixture({
        prefix: 'lever-api-captcha',
        ats: 'LEVER',
        applicationUrl: `${lever.url}/`,
      });
      fixtures.push(fixture);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      await closeBrowserQuietly();
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          timeoutMs: 120_000,
          label: 'captcha submission run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'captcha job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.errorCode).toBe('CAPTCHA_DETECTED');

      const events = await eventsFor(fixture.applicationId);
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain('CAPTCHA_DETECTED');
      expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');
      const captcha = events.find((e) => e.eventType === 'CAPTCHA_DETECTED')!;
      expect((captcha.metadata as Record<string, unknown>).challengeKind).toBe('CAPTCHA');

      // Non-retryable and never solved: one attempt, zero submissions, and
      // every request to the mock form was a GET.
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1);
      expect(lever.submissions.length).toBe(formSubsBefore);

      // Safe API boundary reports the failed run without internals.
      const statusRes = await api(server.port).get(
        `/api/applications/${fixture.applicationId}/automation`
      );
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as { automationRun: Record<string, unknown> };
      expect(statusBody.automationRun.status).toBe('FAILED');
      expect(statusBody.automationRun).not.toHaveProperty('metadata');

      // The HTTP surface maps every submission outcome honestly.
      expect(ORCHESTRATION_ERROR_STATUS.SUBMISSION_FAILED).toBe(502);
      expect(ORCHESTRATION_ERROR_STATUS.SUBMISSION_OUTCOME_UNKNOWN).toBe(409);
      expect(ORCHESTRATION_ERROR_STATUS.REQUIRED_ANSWER_MISSING).toBe(422);
      expect(ORCHESTRATION_ERROR_STATUS.ANSWER_NEEDS_REVIEW).toBe(422);
      expect(ORCHESTRATION_ERROR_STATUS.CAPTCHA_DETECTED).toBe(422);
      expect(ORCHESTRATION_ERROR_STATUS.SECURITY_CHALLENGE).toBe(422);
      expect(ORCHESTRATION_ERROR_STATUS.BLOCKED_BY_SECURITY_POLICY).toBe(422);
      expect(ORCHESTRATION_ERROR_STATUS.TRANSIENT_FAILURE).toBe(503);
    });
  }
);
