/**
 * Phase 15B.2 - Greenhouse Job Board API submission end-to-end tests.
 *
 * The ENTIRE production path is real:
 *   real Express router (POST /api/applications/:id/approve + /submit)
 *     -> real BullMQ submission queue (@jaa/core)
 *     -> real submission worker (same wiring as apps/worker)
 *     -> real submission gate / attempt ledger / AutomationRun lifecycle
 *     -> real ATS registry + Greenhouse adapter (submitApplication)
 *     -> real documented Job Board API client (packages/greenhouse)
 *   -> the ONLY mocks are the loopback mock Greenhouse server (DOM prep /
 *      browser fallback) and the loopback mock Job Board API server.
 *
 * Every scenario proves one contract of the documented, employer-authorized
 * Job Board API path (docs.greenhouse.io/job-board):
 *
 *   1. success carries authoritative provider evidence (PROVIDER_ID when
 *      the provider returns an id, otherwise the documented 2xx signal
 *      HTTP_ACCEPTED) - persisted with transport/warnings, PII-free events;
 *   2-3. a 2xx without an id is accepted on the documented HTTP signal only
 *      - no confirmation id is ever invented;
 *   4. an explicit provider refusal (4xx) is a definitive failure with
 *      exactly ONE request;
 *   5. credential refusals (401/403) are reported precisely and the key is
 *      never leaked anywhere;
 *   6-9. missing required answers, ungroundable required questions, and
 *      missing/unsupported resume files block BEFORE any request is sent
 *      (the docs mandate client-side required validation), never fabricated;
 *   10. a connection-refused request is a definitive PRE-TRANSMISSION
 *      failure ("never transmitted");
 *   11-13. anything that may have reached the provider is an UNKNOWN
 *      outcome: never retried, never claimed as SUBMITTED, never resubmitted
 *      blindly (including a bare 2xx without the documented confirmation on
 *      the browser fallback path);
 *   12. a crash after the external submit can never cause a second
 *      submission - the worker retry AND a fresh job both refuse;
 *   14. duplicate submit requests and duplicate queue jobs collapse into
 *      exactly one submission (idempotency proof);
 *   15. the browser fallback is never silent: the reason is recorded;
 *   16. REAL/unsafe targets are refused fail-closed even with an employer
 *      key configured (no live submissions, ever);
 *   17. CAPTCHA challenges stop the fallback path and are never solved, and
 *      the HTTP surface reports every outcome honestly.
 *
 * All candidate data is synthetic (test.invalid emails, 555-01xx phones).
 * The employer Job Board API key never appears in events, run metadata,
 * queue payloads, or error messages.
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
  type ApiServer,
  type ApplicationFixture,
} from './e2e-helpers';
import {
  startMockGreenhouseServer,
  type MockGreenhouseServer,
} from '../../packages/greenhouse/tests/fixtures/mock-greenhouse-server';
import {
  startMockJobBoardApiServer,
  type MockJobBoardApiServer,
  type MockJobBoardApiOptions,
} from '../../packages/greenhouse/tests/fixtures/mock-job-board-api';
import { ORCHESTRATION_ERROR_STATUS } from '../../src/routes/applications';

// E2E needs BOTH PostgreSQL and Redis; skip honestly when either is down.
const HAS_DB = await hasDatabase();
const HAS_REDIS = await hasRedis();

/** The employer-issued key the mock Job Board API provider requires. */
const MOCK_API_KEY = 'test-job-board-key';
/** A WRONG configured key (scenario 5) - must never leak into any artifact. */
const WRONG_API_KEY = 'wrong-employer-key-DO-NOT-LEAK-8d21';
const RESUME_CONTENT = 'Synthetic approved resume content. Not a real candidate document.\n';
const PREFERRED_NAME_ANSWER = 'Preferred-First-Name-Answer';

/**
 * Documented question list (Job method with `?questions=true`) for the mock
 * Job Board API provider. Labels match the mock Greenhouse DOM exactly so
 * the label-vs-semantic mapping is exercised end to end; choice fields carry
 * documented option `value`s (numeric, as in the docs examples).
 */
const JB_QUESTIONS: NonNullable<MockJobBoardApiOptions['questions']> = [
  { required: true, label: 'First Name', fields: [{ name: 'first_name', type: 'input_text' }] },
  { required: true, label: 'Last Name', fields: [{ name: 'last_name', type: 'input_text' }] },
  { required: true, label: 'Email', fields: [{ name: 'email', type: 'input_text' }] },
  { required: true, label: 'Resume/CV', fields: [{ name: 'resume', type: 'input_file' }] },
  {
    required: true,
    label: 'Are you authorized to work in the United States?',
    fields: [
      {
        name: 'question_71000001',
        type: 'multi_value_single_select',
        values: [
          { value: 1, label: 'Yes' },
          { value: 0, label: 'No' },
        ],
      },
    ],
  },
  {
    required: true,
    label: 'Will you now or in the future require sponsorship for an immigration status?',
    fields: [
      {
        name: 'question_71000002',
        type: 'multi_value_single_select',
        values: [
          { value: 1, label: 'Yes' },
          { value: 0, label: 'No' },
        ],
      },
    ],
  },
  {
    required: false,
    label: 'Preferred First Name',
    fields: [{ name: 'question_71000003', type: 'input_text' }],
  },
];

/**
 * Scenario 7: a required documented question that NO prepared answer can
 * ever ground (its label exists nowhere in the inspected form). The
 * client-side required validation must block before sending - never guess.
 */
const STRICT_QUESTIONS: NonNullable<MockJobBoardApiOptions['questions']> = [
  ...JB_QUESTIONS,
  {
    required: true,
    label: 'How many years of Kubernetes experience do you have?',
    fields: [{ name: 'question_999001', type: 'input_text' }],
  },
];

describe.skipIf(!HAS_DB || !HAS_REDIS)(
  'Phase 15B.2 E2E: Greenhouse Job Board API submission (real API -> queue -> worker -> client -> mock provider)',
  () => {
    let greenhouse: MockGreenhouseServer;
    /** The mock Job Board API provider (behavior switchable per test). */
    let jobBoardApi: MockJobBoardApiServer;
    /** Provider with one extra unanswerable required question (scenario 7). */
    let strictJobBoardApi: MockJobBoardApiServer;
    /** Provider that dies after the question read (scenario 10). */
    let closingJobBoardApi: MockJobBoardApiServer;
    let server: ApiServer;
    const fixtures: ApplicationFixture[] = [];

    beforeAll(async () => {
      greenhouse = await startMockGreenhouseServer();
      jobBoardApi = await startMockJobBoardApiServer({ apiKey: MOCK_API_KEY, questions: JB_QUESTIONS });
      strictJobBoardApi = await startMockJobBoardApiServer({
        apiKey: MOCK_API_KEY,
        questions: STRICT_QUESTIONS,
      });
      closingJobBoardApi = await startMockJobBoardApiServer({
        apiKey: MOCK_API_KEY,
        questions: JB_QUESTIONS,
        closeAfterQuestions: true,
      });
      server = await startApiServer();
      await resetPreparationQueue();
      await resetSubmissionQueue();
    });

    afterAll(async () => {
      clearJobBoardEnv();
      for (const fixture of fixtures) {
        await cleanupFixture(fixture).catch(() => undefined);
      }
      await resetPreparationQueue().catch(() => undefined);
      await resetSubmissionQueue().catch(() => undefined);
      await closeBrowserQuietly();
      await server?.close().catch(() => undefined);
      await greenhouse?.close().catch(() => undefined);
      await jobBoardApi?.close().catch(() => undefined);
      await strictJobBoardApi?.close().catch(() => undefined);
      await closingJobBoardApi?.close().catch(() => undefined);
      await (await getPrisma()).$disconnect().catch(() => undefined);
    });

    beforeEach(async () => {
      clearJobBoardEnv();
      jobBoardApi.setBehavior('ok');
      await resetPreparationQueue();
      await resetSubmissionQueue();
    });

    afterEach(() => {
      clearJobBoardEnv();
    });

    // ------------------------------------------------------------------
    // Environment seams (server-side path selection, read at submit time)
    // ------------------------------------------------------------------

    function clearJobBoardEnv(): void {
      delete process.env.JAA_GREENHOUSE_JOB_BOARD_API_KEY;
      delete process.env.JAA_GREENHOUSE_JOB_BOARD_API_BASE;
    }

    function setJobBoardEnv(apiKey: string, baseUrl?: string): void {
      process.env.JAA_GREENHOUSE_JOB_BOARD_API_KEY = apiKey;
      if (baseUrl) {
        process.env.JAA_GREENHOUSE_JOB_BOARD_API_BASE = baseUrl;
      } else {
        delete process.env.JAA_GREENHOUSE_JOB_BOARD_API_BASE;
      }
    }

    // ------------------------------------------------------------------
    // Pipeline helpers (same proven pattern as the Phase 15A suites)
    // ------------------------------------------------------------------

    async function prepareAndWait(applicationId: string): Promise<void> {
      const res = await api(server.port).post(`/api/applications/${applicationId}/prepare`);
      expect(res.status).toBe(202);
      const worker = await startPreparationWorker();
      try {
        await waitForRun(applicationId, (run) => run.status === 'COMPLETED', {
          label: 'job board preparation run',
        });
        await waitForApplication(applicationId, (app) => app.status === 'FORM_INSPECTED', {
          label: 'job board prepared application',
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
      // Only when the form actually has an Email question (minimal fixture
      // pages may not): the documented API validates the email value.
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

    /** Read one approved answer back (for request-body assertions). */
    async function getAnswer(applicationId: string, label: string): Promise<string> {
      const prisma = await getPrisma();
      const question = await findQuestion(applicationId, label);
      if (!question) throw new Error(`No prepared question with label "${label}"`);
      const answer = await prisma.applicationAnswer.findFirst({
        where: { questionId: question.id },
      });
      return answer?.answer ?? '';
    }

    /**
     * Point the approved resume version at a REAL file on disk - the Job
     * Board API path reads the approved file to send it as the documented
     * base64 attachment (nothing else in the pipeline reads it).
     */
    async function attachRealResume(
      fixture: ApplicationFixture,
      fileName: string,
      content: string
    ): Promise<string> {
      const dir = path.join(os.tmpdir(), 'jaa-e2e-job-board-api');
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

    /** Assert a refused request queued nothing and submitted nothing. */
    async function assertNothingRan(
      applicationId: string,
      counts: { gh: number; jb: number }
    ): Promise<void> {
      expect(await submissionJobsFor(applicationId)).toHaveLength(0);
      expect(greenhouse.submissions.length).toBe(counts.gh);
      expect(jobBoardApi.submissions.length).toBe(counts.jb);
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
    // 1. Success with authoritative provider evidence (PROVIDER_ID)
    // ==================================================================

    it('1. submits through the documented Job Board API with authoritative PROVIDER_ID evidence', async () => {
      const ghSubsBefore = greenhouse.submissions.length;
      const jbSubsBefore = jobBoardApi.submissions.length;
      const jbReqBefore = jobBoardApi.requests.length;
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'jba-main',
        ats: 'GREENHOUSE',
        // Job-board shaped application URL: the DOM prep reads the modern
        // form AND the API target parses board token + job post id.
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);

      await prepareAndWait(fixture.applicationId);
      await answerAllRequiredQuestions(fixture.applicationId);
      await setAnswer(fixture.applicationId, 'Email', fixture.email);
      // Deterministic choice mapping: labels -> documented option values.
      await setAnswer(fixture.applicationId, 'Are you authorized to work in the United States?', 'Yes');
      await setAnswer(
        fixture.applicationId,
        'Will you now or in the future require sponsorship for an immigration status?',
        'No'
      );
      // Label-vs-semantic precedence end to end: the semantic built-in for
      // "Preferred First Name" is first_name, but the documented question
      // with this label owns the answer - first_name must stay untouched.
      await setAnswer(fixture.applicationId, 'Preferred First Name', PREFERRED_NAME_ANSWER);
      await approve(fixture.applicationId);

      const firstNameAnswer = await getAnswer(fixture.applicationId, 'First Name');
      const lastNameAnswer = await getAnswer(fixture.applicationId, 'Last Name');

      // ---- real HTTP API (production router) --------------------------
      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        automationRun: { applicationId: string; status: string };
        enqueued: boolean;
      };
      expect(body.automationRun.applicationId).toBe(fixture.applicationId);
      expect(body.automationRun.status).toBe('QUEUED');
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
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'job board api submitted application',
        });
        await waitForRun(fixture.applicationId, (run) => run.status === 'COMPLETED', {
          label: 'job board api submission run',
        });
      } finally {
        await worker.close();
      }

      // ---- Application: SUBMITTED with the provider's own reference ----
      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('SUBMITTED');
      expect(application!.submittedAt).not.toBeNull();
      expect(application!.errorCode).toBeNull();
      // The reference is the id the provider returned - never invented.
      expect(application!.externalApplicationId).toBe(
        String(900000 + jobBoardApi.submissions.length)
      );

      const run = await runFor(fixture.applicationId);
      expect(run!.status).toBe('COMPLETED');
      expect(run!.completedAt).not.toBeNull();
      expect((run!.metadata as Record<string, unknown>).finalStatus).toBe('SUBMITTED');

      // ---- Audit events: evidence, transport, fallback transparency ----
      const events = await eventsFor(fixture.applicationId);
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes.filter((t) => t === 'SUBMISSION_STARTED')).toHaveLength(1);
      expect(eventTypes.filter((t) => t === 'SUBMISSION_COMPLETED')).toHaveLength(1);
      expect(eventTypes).not.toContain('ERROR');
      expect(eventTypes).not.toContain('SUBMISSION_FAILED');

      const started = events.find((e) => e.eventType === 'SUBMISSION_STARTED')!;
      const startedMeta = started.metadata as {
        submissionAttemptId: string;
        attempt: number;
        provider: string;
      };
      expect(startedMeta.attempt).toBe(1);
      expect(startedMeta.provider).toBe('GREENHOUSE');

      const completed = events.find((e) => e.eventType === 'SUBMISSION_COMPLETED')!;
      const completedMeta = completed.metadata as {
        submissionAttemptId: string;
        confirmationId: string | null;
        confirmationMethod?: string;
        transport?: string;
        httpStatus?: number;
        url: string;
        warnings?: string[];
      };
      expect(completedMeta.submissionAttemptId).toBe(startedMeta.submissionAttemptId);
      expect(completedMeta.confirmationId).toBe(application!.externalApplicationId);
      // Authoritative evidence + which transport carried it (auditable).
      expect(completedMeta.confirmationMethod).toBe('PROVIDER_ID');
      expect(completedMeta.transport).toBe('API');
      expect(completedMeta.httpStatus).toBe(200);
      expect(completedMeta.url.replace(/\/$/, '')).toBe(
        `${greenhouse.url}/testco/jobs/127817`.replace(/\/$/, '')
      );

      // ---- No candidate PII anywhere in the audit trail ---------------
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(fixture.email);
      expect(serialized).not.toContain(fixture.phone);
      expect(serialized).not.toContain('Synthetic answer');
      expect(serialized).not.toContain(PREFERRED_NAME_ANSWER);
      expect(serialized).not.toContain(RESUME_CONTENT.trim());
      // The employer key never leaks either.
      expect(serialized).not.toContain(MOCK_API_KEY);
      expect(serialized).not.toContain(
        Buffer.from(`${MOCK_API_KEY}:`).toString('base64')
      );

      // ---- Exactly one question read + one submission request ---------
      const jbRequests = jobBoardApi.requests.slice(jbReqBefore);
      expect(jbRequests).toHaveLength(2);
      expect(jbRequests[0].method).toBe('GET');
      expect(jbRequests[0].path).toBe('/v1/boards/testco/jobs/127817');
      expect(jbRequests[1].method).toBe('POST');
      expect(jbRequests[1].path).toBe('/v1/boards/testco/jobs/127817');
      // Documented auth: Basic with the Job Board API key as username.
      expect(jbRequests[1].authorization).toBe(
        `Basic ${Buffer.from(`${MOCK_API_KEY}:`).toString('base64')}`
      );

      // ---- The documented request body: mapped fields, never guessed ---
      const mySubmissions = jobBoardApi.submissions.slice(jbSubsBefore);
      expect(mySubmissions).toHaveLength(1);
      const sent = mySubmissions[0] as Record<string, unknown>;
      expect(sent.first_name).toBe(firstNameAnswer);
      expect(sent.last_name).toBe(lastNameAnswer);
      expect(sent.email).toBe(fixture.email);
      // Choice answers are the DOCUMENTED option values (numeric).
      expect(sent.question_71000001).toBe(1);
      expect(sent.question_71000002).toBe(0);
      // The label-matched question owns its answer; the semantic built-in
      // never overwrites a different documented question.
      expect(sent.question_71000003).toBe(PREFERRED_NAME_ANSWER);
      expect(sent.first_name).not.toBe(PREFERRED_NAME_ANSWER);
      // The approved resume travels as the documented base64 attachment.
      expect(sent.resume_content).toBe(Buffer.from(RESUME_CONTENT).toString('base64'));
      expect(String(sent.resume_content_filename)).toMatch(/-resume\.txt$/);
      // The FILE answer text is never sent as an answer value.
      expect(JSON.stringify(sent)).not.toContain('test/synthetic-upload');
      expect(sent).not.toHaveProperty('mapped_url_token');

      // ---- The browser fallback was NOT used --------------------------
      expect(greenhouse.submissions.length).toBe(ghSubsBefore);

      // ---- Safe API boundary (no metadata, no answers) ----------------
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

    // ==================================================================
    // 2-3. A 2xx without an id is the documented signal only
    // ==================================================================

    it('2. treats a 2xx with an empty body as HTTP_ACCEPTED and never invents a confirmation id', async () => {
      const jbSubsBefore = jobBoardApi.submissions.length;
      const jbReqBefore = jobBoardApi.requests.length;
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);
      jobBoardApi.setBehavior('empty-body');

      const fixture = await createApplicationFixture({
        prefix: 'jba-empty-body',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'empty-body submission',
        });
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('SUBMITTED');
      // The response body is undocumented and empty: NO id is invented.
      expect(application!.externalApplicationId).toBeNull();

      const events = await eventsFor(fixture.applicationId);
      const completed = events.find((e) => e.eventType === 'SUBMISSION_COMPLETED')!;
      const completedMeta = completed.metadata as Record<string, unknown>;
      // Evidence is exactly the documented 2xx signal - nothing stronger.
      expect(completedMeta.confirmationMethod).toBe('HTTP_ACCEPTED');
      expect(completedMeta.confirmationId).toBeNull();
      expect(completedMeta.transport).toBe('API');
      expect(completedMeta.httpStatus).toBe(200);

      // Exactly one submission request, recorded once by the provider.
      expect(jobBoardApi.requests.slice(jbReqBefore)).toHaveLength(2);
      expect(jobBoardApi.submissions.slice(jbSubsBefore)).toHaveLength(1);
    });

    it('3. treats a 2xx with an undocumented body as HTTP_ACCEPTED evidence only', async () => {
      const jbSubsBefore = jobBoardApi.submissions.length;
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);
      jobBoardApi.setBehavior('malformed-body');

      const fixture = await createApplicationFixture({
        prefix: 'jba-malformed-body',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'malformed-body submission',
        });
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('SUBMITTED');
      // No id can be parsed or invented from the junk body.
      expect(application!.externalApplicationId).toBeNull();

      const completed = (await eventsFor(fixture.applicationId)).find(
        (e) => e.eventType === 'SUBMISSION_COMPLETED'
      )!;
      const completedMeta = completed.metadata as Record<string, unknown>;
      expect(completedMeta.confirmationMethod).toBe('HTTP_ACCEPTED');
      expect(completedMeta.confirmationId).toBeNull();
      expect(completedMeta.transport).toBe('API');
      expect(jobBoardApi.submissions.slice(jbSubsBefore)).toHaveLength(1);
    });

    // ==================================================================
    // 4. Explicit provider refusal is definitive
    // ==================================================================

    it('4. reports an explicit provider refusal (HTTP 422) as a definitive failure with exactly one request', async () => {
      const jbSubsBefore = jobBoardApi.submissions.length;
      const jbReqBefore = jobBoardApi.requests.length;
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);
      jobBoardApi.setBehavior('reject');

      const fixture = await createApplicationFixture({
        prefix: 'jba-reject',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'rejected submission run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'rejected submission job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_FAILED');
      expect(application!.errorMessage).toContain('(HTTP 422)');

      const run = await runFor(fixture.applicationId);
      expect(run!.status).toBe('FAILED');
      expect(run!.completedAt).not.toBeNull();
      expect((run!.metadata as Record<string, unknown>).errorCode).toBe('SUBMISSION_FAILED');

      // Definitive refusal, never auto-retried: exactly one attempt.
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1);

      const events = await eventsFor(fixture.applicationId);
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain('SUBMISSION_STARTED');
      expect(eventTypes).toContain('SUBMISSION_FAILED'); // resolved: NOT submitted
      expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');

      // The provider refused: nothing was recorded there.
      expect(jobBoardApi.submissions.slice(jbSubsBefore)).toHaveLength(0);
      // One question read + one submission request - never a retry.
      expect(jobBoardApi.requests.slice(jbReqBefore)).toHaveLength(2);

      // A definitive failure resolves the attempt marker (unlike UNKNOWN).
      const { findUnresolvedSubmissionAttempt } = await import('@jaa/core');
      expect(await findUnresolvedSubmissionAttempt(fixture.applicationId)).toBeNull();

      // Safe API boundary reports the failure honestly.
      const statusRes = await api(server.port).get(
        `/api/applications/${fixture.applicationId}/automation`
      );
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as { automationRun: Record<string, unknown> };
      expect(statusBody.automationRun.status).toBe('FAILED');
      expect(statusBody.automationRun).not.toHaveProperty('metadata');
    });

    // ==================================================================
    // 5. Credential refusals: precise and never leaked
    // ==================================================================

    it('5. refuses credential failures precisely (HTTP 401) and never leaks the employer key', async () => {
      const jbSubsBefore = jobBoardApi.submissions.length;
      const jbReqBefore = jobBoardApi.requests.length;
      // The configured key does not match the employer-issued key.
      setJobBoardEnv(WRONG_API_KEY, jobBoardApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'jba-auth',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'auth-failure run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'auth-failure job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_FAILED');
      expect(application!.errorMessage).toContain(
        'refused the configured employer credentials'
      );

      // Credentials are refused BEFORE the application is evaluated.
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1);
      expect(jobBoardApi.submissions.slice(jbSubsBefore)).toHaveLength(0);
      const jbRequests = jobBoardApi.requests.slice(jbReqBefore);
      expect(jbRequests).toHaveLength(2);
      expect(jbRequests[1].method).toBe('POST');
      expect(jbRequests[1].authorization).toBe(
        `Basic ${Buffer.from(`${WRONG_API_KEY}:`).toString('base64')}`
      );

      // Neither configured nor expected key ever leaks into any artifact.
      const prisma = await getPrisma();
      const events = await eventsFor(fixture.applicationId);
      const run = await runFor(fixture.applicationId);
      const serialized = JSON.stringify({ events, run, application });
      expect(serialized).not.toContain(WRONG_API_KEY);
      expect(serialized).not.toContain(MOCK_API_KEY);
      expect(serialized).not.toContain(Buffer.from(`${WRONG_API_KEY}:`).toString('base64'));
      expect(serialized).not.toContain(Buffer.from(`${MOCK_API_KEY}:`).toString('base64'));
      void prisma;

      const { findUnresolvedSubmissionAttempt } = await import('@jaa/core');
      expect(await findUnresolvedSubmissionAttempt(fixture.applicationId)).toBeNull();
    });

    // ==================================================================
    // 6-9. Required validation and resume rules block BEFORE sending
    // ==================================================================

    it('6. blocks submission before enqueueing when a required answer is missing', async () => {
      const counts = { gh: greenhouse.submissions.length, jb: jobBoardApi.submissions.length };
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'jba-missing',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await prepareAndWait(fixture.applicationId);

      const prisma = await getPrisma();
      const questions = await prisma.applicationQuestion.findMany({
        where: { applicationId: fixture.applicationId, required: true },
      });
      const unanswered = questions.find((q) => normLabel(q.label) === 'last name')!;
      expect(unanswered).toBeDefined();
      await answerAllRequiredQuestions(fixture.applicationId, {
        skipQuestionIds: [unanswered.id],
      });
      await setAnswer(fixture.applicationId, 'Email', fixture.email);
      await approve(fixture.applicationId);
      void prisma;

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('REQUIRED_ANSWER_MISSING');
      // Question IDs only - no question text, no answer text.
      expect(body.error.message).toContain(unanswered.id);

      await assertNothingRan(fixture.applicationId, counts);
    });

    it('7. blocks before sending when a documented required question has no grounded answer (never fabricated)', async () => {
      const jbReqBefore = strictJobBoardApi.requests.length;
      setJobBoardEnv(MOCK_API_KEY, strictJobBoardApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'jba-strict',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'ungroundable required question run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'required-violation job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_FAILED');
      // The mandated client-side required validation refuses before the
      // request - naming the FIELD only, never an invented answer.
      expect(application!.errorMessage).toContain('question_999001');
      expect(application!.errorMessage).toContain('never fabricated');
      expect(application!.errorMessage).not.toContain('Synthetic answer');

      // Nothing was transmitted: one question read, zero submissions.
      const strictRequests = strictJobBoardApi.requests.slice(jbReqBefore);
      expect(strictRequests).toHaveLength(1);
      expect(strictRequests[0].method).toBe('GET');
      expect(strictJobBoardApi.submissions).toHaveLength(0);

      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1); // deterministic, never retried
    });

    it('8. blocks before sending when the approved resume file is empty', async () => {
      const jbReqBefore = jobBoardApi.requests.length;
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'jba-empty-resume',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      // A real file with zero bytes: documented rule "files must be > 0".
      await attachRealResume(fixture, 'resume.txt', '');
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'empty resume run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'empty resume job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_FAILED');
      expect(application!.errorMessage).toContain('nothing was submitted');
      expect(application!.errorMessage).toContain('empty');

      // Pre-send failure: one question read, zero submission requests.
      const jbRequests = jobBoardApi.requests.slice(jbReqBefore);
      expect(jbRequests).toHaveLength(1);
      expect(jbRequests[0].method).toBe('GET');
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1);
    });

    it('9. blocks before sending when the approved resume type is not document-supported', async () => {
      const jbReqBefore = jobBoardApi.requests.length;
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'jba-badext',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      // Real content, unsupported type: the documented attachment rules
      // (pdf, doc, docx, txt, rtf) refuse it before anything is sent.
      await attachRealResume(fixture, 'resume.exe', 'MZ synthetic non-resume content');
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'bad attachment run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'bad attachment job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_FAILED');
      expect(application!.errorMessage).toContain('not an allowed attachment type');

      const jbRequests = jobBoardApi.requests.slice(jbReqBefore);
      expect(jbRequests).toHaveLength(1);
      expect(jbRequests[0].method).toBe('GET');
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1);
    });

    // ==================================================================
    // 10-13. Transmission boundaries: definitive vs UNKNOWN
    // ==================================================================

    it('10. reports a connection-refused submission request as a pre-transmission failure ("never transmitted")', async () => {
      setJobBoardEnv(MOCK_API_KEY, closingJobBoardApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'jba-refused',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'connection-refused run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'connection-refused job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).toBe('FAILED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_FAILED');
      // A request that provably never left this machine is a KNOWN failure.
      expect(application!.errorMessage).toContain('never transmitted');
      expect(application!.errorMessage).toContain('nothing was submitted');

      // The provider only ever saw the question read - no submission.
      const requests = closingJobBoardApi.requests;
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe('GET');
      expect(closingJobBoardApi.submissions).toHaveLength(0);

      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1); // deterministic, never retried

      // Definitive: the marker is resolved (unlike an unknown outcome).
      const { findUnresolvedSubmissionAttempt } = await import('@jaa/core');
      expect(await findUnresolvedSubmissionAttempt(fixture.applicationId)).toBeNull();
    });

    it('11. treats a submission request that dies in transit as UNKNOWN and never retries it', async () => {
      const jbSubsBefore = jobBoardApi.submissions.length;
      const jbReqBefore = jobBoardApi.requests.length;
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);
      // The provider connection is destroyed mid-request: the request MAY
      // have arrived - the outcome can never be proven either way.
      jobBoardApi.setBehavior('destroy');

      const fixture = await createApplicationFixture({
        prefix: 'jba-intransit',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'in-transit failure run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'in-transit job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      // Never claimed as SUBMITTED, never claimed as definitively failed.
      expect(application!.status).not.toBe('SUBMITTED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.externalApplicationId).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_OUTCOME_UNKNOWN');

      const run = await runFor(fixture.applicationId);
      expect(run!.status).toBe('FAILED');
      expect((run!.metadata as Record<string, unknown>).errorCode).toBe(
        'SUBMISSION_OUTCOME_UNKNOWN'
      );

      // UNKNOWN outcomes are NEVER retried blindly: exactly one attempt.
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1);
      const jbRequests = jobBoardApi.requests.slice(jbReqBefore);
      expect(jbRequests.filter((r) => r.method === 'POST')).toHaveLength(1);
      expect(jobBoardApi.submissions.slice(jbSubsBefore)).toHaveLength(0);

      const events = await eventsFor(fixture.applicationId);
      expect(
        events.some(
          (e) =>
            e.eventType === 'ERROR' &&
            (e.metadata as Record<string, unknown>).code === 'SUBMISSION_OUTCOME_UNKNOWN'
        )
      ).toBe(true);
      expect(events.map((e) => e.eventType)).not.toContain('SUBMISSION_COMPLETED');

      // The attempt marker stays UNRESOLVED - that is what stops resubmits.
      const { findUnresolvedSubmissionAttempt } = await import('@jaa/core');
      expect(await findUnresolvedSubmissionAttempt(fixture.applicationId)).not.toBeNull();
    });

    it('12. a crash after the API submission can never cause a second submission', async () => {
      const jbSubsBefore = jobBoardApi.submissions.length;
      const jbReqBefore = jobBoardApi.requests.length;
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'jba-crash',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);

      // The dangerous boundary: the Job Board API ACCEPTS the application,
      // then the worker "dies" before any bookkeeping. The real
      // submitApplication runs (real client -> mock provider); only the
      // process death is simulated.
      const {
        submitApplication,
        SimulatedWorkerCrash,
        findUnresolvedSubmissionAttempt,
        enqueueSubmissionJob,
      } = await import('@jaa/core');
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
      expect(jobBoardApi.submissions.slice(jbSubsBefore)).toHaveLength(1);
      // The BullMQ retry ran but refused before touching the provider.
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(2);
      expect(jobBoardApi.requests.slice(jbReqBefore)).toHaveLength(2); // 1 GET + 1 POST, no more

      // A completely fresh job must ALSO refuse while the marker is open.
      const run = await runFor(fixture.applicationId);
      await enqueueSubmissionJob({
        applicationId: fixture.applicationId,
        automationRunId: run!.id,
      });
      const worker2 = await startSubmissionWorker();
      try {
        await waitForJobsSettled(fixture.applicationId, 2, 'fresh job refused');
      } finally {
        await worker2.close();
      }

      // The provider still saw exactly one submission - ever.
      expect(jobBoardApi.submissions.slice(jbSubsBefore)).toHaveLength(1);
      expect(jobBoardApi.requests.slice(jbReqBefore)).toHaveLength(2);
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

    it('13. never claims SUBMITTED from a 2xx without the documented confirmation (browser fallback)', async () => {
      const jbReqBefore = jobBoardApi.requests.length;
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);

      // Not job-board shaped: the fallback form path is selected (with its
      // reason recorded), and this form answers 2xx WITHOUT the documented
      // mock confirmation - a bare 2xx must never be claimed as success
      // where the contract requires a confirmation.
      const fixture = await createApplicationFixture({
        prefix: 'jba-no-conf',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/submit-no-confirmation`,
      });
      fixtures.push(fixture);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
          label: 'no-confirmation run',
        });
        await waitForJobsSettled(fixture.applicationId, 1, 'no-confirmation job settled');
      } finally {
        await worker.close();
      }

      const application = await applicationFor(fixture.applicationId);
      expect(application!.status).not.toBe('SUBMITTED');
      expect(application!.submittedAt).toBeNull();
      expect(application!.externalApplicationId).toBeNull();
      expect(application!.errorCode).toBe('SUBMISSION_OUTCOME_UNKNOWN');

      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1);

      // Exactly one envelope request reached the mock ATS, never retried.
      const mySubmissions = greenhouse.submissions.filter(
        (s) => s.reason === 'no-confirmation'
      );
      expect(mySubmissions).toHaveLength(1);

      // The Job Board API was never consulted for this unparseable URL.
      expect(jobBoardApi.requests.slice(jbReqBefore)).toHaveLength(0);

      const { findUnresolvedSubmissionAttempt } = await import('@jaa/core');
      expect(await findUnresolvedSubmissionAttempt(fixture.applicationId)).not.toBeNull();
    });

    // ==================================================================
    // 14. Idempotency: duplicates collapse into one submission
    // ==================================================================

    it('14. collapses duplicate submit requests and duplicate queue jobs into one submission', async () => {
      const jbSubsBefore = jobBoardApi.submissions.length;
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'jba-idem',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixture);
      await attachRealResume(fixture, 'resume.txt', RESUME_CONTENT);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      // Duplicate + concurrent requests collapse at the run claim.
      const [first, second] = await Promise.all([
        submit(fixture.applicationId),
        submit(fixture.applicationId),
      ]);
      expect([first.status, second.status].every((s) => s === 202 || s === 200)).toBe(true);
      const third = await submit(fixture.applicationId);
      expect([200, 202]).toContain(third.status);
      expect(await submissionJobsFor(fixture.applicationId)).toHaveLength(1);

      // A duplicated QUEUE job must not become a second submission either.
      const { enqueueSubmissionJob } = await import('@jaa/core');
      const run = await runFor(fixture.applicationId);
      await enqueueSubmissionJob({
        applicationId: fixture.applicationId,
        automationRunId: run!.id,
      });
      expect(await submissionJobsFor(fixture.applicationId)).toHaveLength(2);

      const worker = await startSubmissionWorker();
      try {
        await waitForApplication(fixture.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'idempotent job board submission',
        });
        await waitForJobsSettled(fixture.applicationId, 2, 'both queue jobs settled');
      } finally {
        await worker.close();
      }

      // One logical submission despite three API requests + two jobs.
      const prisma = await getPrisma();
      expect(
        await prisma.automationRun.count({ where: { applicationId: fixture.applicationId } })
      ).toBe(1);
      expect(jobBoardApi.submissions.slice(jbSubsBefore)).toHaveLength(1);
      expect(jobBoardApi.requests.filter((r) => r.method === 'POST')).not.toHaveLength(0);

      const events = await eventsFor(fixture.applicationId);
      expect(events.filter((e) => e.eventType === 'SUBMISSION_STARTED')).toHaveLength(1);
      expect(events.filter((e) => e.eventType === 'SUBMISSION_COMPLETED')).toHaveLength(1);

      // A later submit is a no-op: the provider count stays at one.
      const again = await submit(fixture.applicationId);
      expect(again.status).toBe(200);
      const againBody = (await again.json()) as { alreadySubmitted: boolean };
      expect(againBody.alreadySubmitted).toBe(true);
      expect(jobBoardApi.submissions.slice(jbSubsBefore)).toHaveLength(1);
    });

    // ==================================================================
    // 15. The browser fallback is never silent
    // ==================================================================

    it('15. falls back to the application form with a recorded reason when the API path is unavailable', async () => {
      const jbReqBefore = jobBoardApi.requests.length;

      // ---- (a) no employer key configured -----------------------------
      const fixtureA = await createApplicationFixture({
        prefix: 'jba-fallback-nokey',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixtureA);
      await prepareAndWait(fixtureA.applicationId);
      await answerAndApprove(fixtureA);
      expect((await submit(fixtureA.applicationId)).status).toBe(202);
      const workerA = await startSubmissionWorker();
      try {
        await waitForApplication(fixtureA.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'fallback (no key) submission',
        });
      } finally {
        await workerA.close();
      }

      const eventsA = await eventsFor(fixtureA.applicationId);
      const completedA = eventsA.find((e) => e.eventType === 'SUBMISSION_COMPLETED')!;
      const metaA = completedA.metadata as {
        transport?: string;
        warnings?: string[];
        confirmationId: string | null;
      };
      // The fallback ran at the MOCK envelope boundary and is auditable.
      expect(metaA.transport).toBe('BROWSER');
      expect(metaA.confirmationId).toMatch(/^mock-gh-app-\d+$/);
      expect(JSON.stringify(metaA.warnings ?? [])).toContain(
        'No employer-issued Job Board API key'
      );

      // ---- (b) key configured but MOCK mode lacks a loopback fixture ---
      setJobBoardEnv(MOCK_API_KEY); // no TEST-ONLY base URL
      const fixtureB = await createApplicationFixture({
        prefix: 'jba-fallback-nobase',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/testco/jobs/127817`,
      });
      fixtures.push(fixtureB);
      await prepareAndWait(fixtureB.applicationId);
      await answerAndApprove(fixtureB);
      expect((await submit(fixtureB.applicationId)).status).toBe(202);
      const workerB = await startSubmissionWorker();
      try {
        await waitForApplication(fixtureB.applicationId, (app) => app.status === 'SUBMITTED', {
          label: 'fallback (no loopback base) submission',
        });
      } finally {
        await workerB.close();
      }

      const eventsB = await eventsFor(fixtureB.applicationId);
      const completedB = eventsB.find((e) => e.eventType === 'SUBMISSION_COMPLETED')!;
      const metaB = completedB.metadata as { transport?: string; warnings?: string[] };
      expect(metaB.transport).toBe('BROWSER');
      // A mock run can never transmit candidate data to the real API.
      expect(JSON.stringify(metaB.warnings ?? [])).toContain(
        'loopback Job Board API fixture base URL'
      );

      // The Job Board API provider was never consulted in either run.
      expect(jobBoardApi.requests.length).toBe(jbReqBefore);
    });

    // ==================================================================
    // 16. REAL and unsafe targets fail closed, even with a key configured
    // ==================================================================

    it('16. refuses REAL and unsafe targets fail-closed even when an employer key is configured', async () => {
      const counts = { gh: greenhouse.submissions.length, jb: jobBoardApi.submissions.length };
      const jbReqBefore = jobBoardApi.requests.length;
      // The REAL submission capability stays OFF - no live submissions.
      expect(process.env.JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED ?? '').not.toBe('true');
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);

      const unsafeUrls: { url: string; code: string }[] = [
        // A REAL Greenhouse board with the documented URL shape: the
        // employer key must NOT bypass the fail-closed target policy.
        {
          url: 'https://job-boards.greenhouse.io/real-company/jobs/999999',
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
          prefix: `jba-url-${unsafe.code.toLowerCase().replace(/_/g, '-')}-${Math.random()
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

        await assertNothingRan(fixture.applicationId, counts);
      }

      // No provider was ever consulted - fail closed before anything runs.
      expect(jobBoardApi.requests.length).toBe(jbReqBefore);
      expect(greenhouse.submissions.length).toBe(counts.gh);
    });

    // ==================================================================
    // 17. Challenges stop the fallback; outcomes are reported honestly
    // ==================================================================

    it('17. stops on a CAPTCHA in the fallback path and reports every outcome honestly', async () => {
      const ghSubsBefore = greenhouse.submissions.length;
      const ghReqBefore = greenhouse.requests.length;
      // Even with an employer key configured, a non-API-shaped URL runs the
      // form path - where the CAPTCHA policy is unchanged: never solved.
      setJobBoardEnv(MOCK_API_KEY, jobBoardApi.url);

      const fixture = await createApplicationFixture({
        prefix: 'jba-captcha',
        ats: 'GREENHOUSE',
        applicationUrl: `${greenhouse.url}/captcha`,
      });
      fixtures.push(fixture);
      await prepareAndWait(fixture.applicationId);
      await answerAndApprove(fixture);

      const res = await submit(fixture.applicationId);
      expect(res.status).toBe(202);
      const worker = await startSubmissionWorker();
      try {
        await waitForRun(fixture.applicationId, (run) => run.status === 'FAILED', {
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
      // every request to the mock ATS was a GET.
      const jobs = await submissionJobsFor(fixture.applicationId);
      expect(jobs[0].attemptsMade).toBe(1);
      expect(greenhouse.submissions.length).toBe(ghSubsBefore);
      expect(
        greenhouse.requests.slice(ghReqBefore).every((r) => r.method === 'GET')
      ).toBe(true);

      // Safe API boundary reports the failed run without internals.
      const statusRes = await api(server.port).get(
        `/api/applications/${fixture.applicationId}/automation`
      );
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as { automationRun: Record<string, unknown> };
      expect(statusBody.automationRun.status).toBe('FAILED');
      expect(statusBody.automationRun).not.toHaveProperty('metadata');

      // The HTTP surface maps every submission outcome honestly (the same
      // table the production router uses - e.g. REQUIRED_ANSWER_MISSING
      // really answered 422 in scenario 6).
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
