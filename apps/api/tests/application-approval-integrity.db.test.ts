import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Load DATABASE_URL before @jaa/database instantiates Prisma (repo convention).
import dotenv from 'dotenv';
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
});

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/jaa_dev';

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { prisma } = await import('@jaa/database');
const {
  submitApplication,
  approveApplicationForSubmission,
  generateApplicationAnswers,
  findUnresolvedSubmissionAttempt,
  findUnresolvedSubmissionAttempts,
  hasSubmissionAttemptHistory,
  checkPreparationEligibility,
  checkSubmissionEligibility,
  getSubmissionStatus,
  REAL_GREENHOUSE_SUBMISSION_FLAG,
} = await import('@jaa/core');
const { AtsRegistry } = await import('@jaa/ats');
type AtsAdapter = import('@jaa/ats').AtsAdapter;
type AtsSubmissionContext = import('@jaa/ats').AtsSubmissionContext;
type AtsSubmissionResult = import('@jaa/ats').AtsSubmissionResult;

/**
 * Phase 15D Suite 1 - shared lifecycle & approval-integrity regression suite.
 *
 * The approval is the ONLY gate to submission, and it binds the EXACT
 * application content (target, resume version, questions/answers). These
 * tests pin the lifecycle guarantees end to end at the workflow level:
 *
 *   - the explicit approval action binds a content snapshot (hashes and
 *     identifiers only - never content);
 *   - ANY post-approval drift (answer edit, resume edit/swap, changed target)
 *     or an approval that was never bound refuses the submission attempt
 *     FAIL CLOSED - before any request, before any attempt marker - and
 *     returns the application to "awaiting approval";
 *   - what is sent is exactly the snapshot-verified content handed over by
 *     the attempt claim - never anything newer;
 *   - regeneration never overwrites approved answers, and invalidates the
 *     approval only when answer text actually changes;
 *   - content is immutable while a submission is in flight or submitted;
 *   - an UNKNOWN submission outcome freezes the lifecycle: it is never reset
 *     to a fresh state and never resubmitted blindly.
 *
 * Zero network: the recording stub adapter never touches the network or the
 * page. Every scenario runs the REAL workflow (claim ledger, snapshot
 * verification, bookkeeping) against the real database.
 */

const TEST_USER_ID = 'appr-integrity-user';

/** Distinctive synthetic values - used to prove they never leak to events. */
const ANSWER_NAME = 'Zorblatt';
const ANSWER_EMAIL = 'zorblatt-candidate@example.com';
const COVER_NOTE = 'Synthetic cover note for the approval integrity suite.';
/** Seeded on an UNAPPROVED answer so regeneration deterministically changes it. */
const STALE_SENTINEL = 'stale sentinel answer text 7f3c9a2b no generator would produce';
/** Edited after approval - the drift that must invalidate the approval. */
const EDITED_ANSWER = 'EditedAfterApproval';
/** Simulated concurrent write at request time (claim->fill hand-over test). */
const MID_FLIGHT_EDIT = 'MidFlightEditXyz';

const MOCK_URL = 'http://127.0.0.1:9111/applications/new';
const MOCK_URL_OTHER = 'http://127.0.0.1:9111/other/new';

class RecordingAdapter implements AtsAdapter {
  readonly provider = 'GREENHOUSE';
  readonly name = 'Recording test adapter';
  readonly contexts: AtsSubmissionContext[] = [];

  constructor(
    private readonly result: Partial<AtsSubmissionResult>,
    /**
     * Invoked when the request reaches the adapter (AFTER the attempt claim
     * and after the submission content is fixed) - used to simulate a
     * concurrent content change at request time.
     */
    private readonly onRequest?: (context: AtsSubmissionContext) => void | Promise<void>
  ) {}

  canHandle(): boolean {
    return true;
  }

  async inspectApplication(): Promise<never> {
    throw new Error('not used in this test');
  }

  async prepareApplication(): Promise<never> {
    throw new Error('not used in this test');
  }

  async submitApplication(context: AtsSubmissionContext): Promise<AtsSubmissionResult> {
    this.contexts.push(context);
    if (this.onRequest) await this.onRequest(context);
    return {
      provider: this.provider,
      url: context.url,
      outcome: 'SUBMITTED',
      externalApplicationId: null,
      confirmationUrl: null,
      httpStatus: null,
      challenge: null,
      warnings: [],
      ...this.result,
    };
  }
}

function registryWith(adapter: AtsAdapter): import('@jaa/ats').AtsRegistry {
  const registry = new AtsRegistry();
  registry.register(adapter);
  return registry;
}

/** A verified provider confirmation (the only accepted evidence). */
function verified(reference: string): Partial<AtsSubmissionResult> {
  return {
    externalApplicationId: reference,
    confirmation: { method: 'PROVIDER_ID', reference, url: MOCK_URL },
    confirmationUrl: MOCK_URL,
    httpStatus: 200,
  };
}

let counter = 0;
let jobId: string;

/**
 * Create an application at FORM_INSPECTED with three questions (two required,
 * one optional) and explicit answer rows, then approve it through the REAL
 * approval action - exactly like the product flow.
 */
async function makeApplication(options: {
  applicationUrl?: string;
  /** Approve via the real action after answers exist (default true). */
  approve?: boolean;
  /** Cover-note answer row; null leaves the question unanswered. */
  coverAnswer?: { text: string; approved: boolean } | null;
} = {}) {
  counter += 1;
  const applicationUrl = options.applicationUrl ?? MOCK_URL;
  const resume = await prisma.resume.create({
    data: {
      userId: TEST_USER_ID,
      name: `ApprIntegrity resume ${counter}`,
      originalFileName: `appr-integrity-${counter}.txt`,
      fileType: 'pdf',
      storageKey: `test/appr-integrity-${counter}.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
    },
  });
  const version = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: path.resolve(`test/appr-integrity-${counter}-v1.txt`),
      source: 'ORIGINAL',
      reviewStatus: 'APPROVED',
    },
  });
  const application = await prisma.application.create({
    data: {
      userId: TEST_USER_ID,
      jobId,
      resumeVersionId: version.id,
      ats: 'GREENHOUSE',
      applicationUrl,
      status: 'FORM_INSPECTED',
    },
  });

  const questionName = await prisma.applicationQuestion.create({
    data: {
      applicationId: application.id,
      externalFieldId: 'first_name',
      label: 'First Name',
      normalizedLabel: 'first_name',
      fieldType: 'TEXT',
      required: true,
      locator: { cssSelector: '#first_name', attributes: { semantic: 'first_name' } } as object,
      answer: { create: { answer: ANSWER_NAME, source: 'USER_INPUT', approved: true } },
    },
  });
  const questionEmail = await prisma.applicationQuestion.create({
    data: {
      applicationId: application.id,
      externalFieldId: 'email',
      label: 'Email',
      normalizedLabel: 'email',
      fieldType: 'EMAIL',
      required: true,
      locator: { cssSelector: '#email', attributes: { semantic: 'email' } } as object,
      answer: { create: { answer: ANSWER_EMAIL, source: 'USER_INPUT', approved: true } },
    },
  });
  const coverAnswer =
    options.coverAnswer === undefined
      ? { text: COVER_NOTE, approved: true }
      : options.coverAnswer;
  const questionCover = await prisma.applicationQuestion.create({
    data: {
      applicationId: application.id,
      externalFieldId: 'cover_note',
      label: 'Cover Note',
      normalizedLabel: 'cover_note',
      fieldType: 'TEXTAREA',
      required: false,
      locator: { cssSelector: '#cover_note', attributes: {} } as object,
      ...(coverAnswer
        ? {
            answer: {
              create: {
                answer: coverAnswer.text,
                source: 'USER_INPUT',
                approved: coverAnswer.approved,
              },
            },
          }
        : {}),
    },
  });

  // Phase 15D: the explicit approval action binds the exact content snapshot.
  if (options.approve !== false) {
    await approveApplicationForSubmission({
      applicationId: application.id,
      userId: TEST_USER_ID,
    });
  }

  return { application, version, questionName, questionEmail, questionCover };
}

async function freshApplication(applicationId: string) {
  return prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
}

async function reviewApprovedEvents(applicationId: string) {
  return prisma.applicationEvent.findMany({
    where: { applicationId, eventType: 'REVIEW_APPROVED' },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * The REVIEW_REQUESTED event written by the approval invalidation (a
 * regeneration may also write a review-summary REVIEW_REQUESTED event - the
 * invalidation one is the event carrying the drift components).
 */
async function invalidationEvent(applicationId: string) {
  const events = await prisma.applicationEvent.findMany({
    where: { applicationId, eventType: 'REVIEW_REQUESTED' },
    orderBy: { createdAt: 'desc' },
  });
  return (
    events.find((event) => {
      const metadata = event.metadata as Record<string, unknown> | null;
      return metadata != null && Array.isArray(metadata['drift']);
    }) ?? null
  );
}

/** Assert no event metadata anywhere contains prepared answer content. */
async function expectNoContentInEvents(applicationId: string): Promise<void> {
  const events = await prisma.applicationEvent.findMany({ where: { applicationId } });
  for (const event of events) {
    const metadata = JSON.stringify(event.metadata);
    expect(metadata).not.toContain(ANSWER_NAME);
    expect(metadata).not.toContain(ANSWER_EMAIL);
    expect(metadata).not.toContain(COVER_NOTE);
  }
}

function submitParams(applicationId: string, adapter: AtsAdapter) {
  return {
    applicationId,
    userId: TEST_USER_ID,
    registry: registryWith(adapter),
    headless: true,
    allowPrivateUrls: true,
  };
}

describe.skipIf(!HAS_DB)(
  'Phase 15D - application lifecycle & approval integrity (database integration, zero network)',
  () => {
    beforeAll(async () => {
      await prisma.user.upsert({
        where: { id: TEST_USER_ID },
        update: {},
        create: {
          id: TEST_USER_ID,
          email: 'appr-integrity-user@test.local',
          name: 'Appr Integrity User',
        },
      });
      await prisma.candidateProfile.upsert({
        where: { userId: TEST_USER_ID },
        update: {},
        create: {
          userId: TEST_USER_ID,
          firstName: 'Zorblatt',
          lastName: 'Candidate',
          email: ANSWER_EMAIL,
          phone: '+1-555-0199',
          summary: 'Synthetic approval-integrity test candidate. Not a real person.',
        },
      });
      const job = await prisma.job.create({
        data: {
          userId: TEST_USER_ID,
          source: 'GREENHOUSE',
          url: `https://example.com/appr-integrity-job-${Date.now()}`,
          company: 'Appr Integrity Co',
          title: 'Appr Integrity Role',
        },
      });
      jobId = job.id;
    });

    afterAll(async () => {
      await prisma.automationRun.deleteMany({ where: { userId: TEST_USER_ID } });
      await prisma.applicationEvent.deleteMany({ where: { userId: TEST_USER_ID } });
      await prisma.application.deleteMany({ where: { userId: TEST_USER_ID } });
      await prisma.resume.deleteMany({ where: { userId: TEST_USER_ID } });
      await prisma.job.deleteMany({ where: { userId: TEST_USER_ID } });
      await prisma.user.deleteMany({ where: { id: TEST_USER_ID } });
      await prisma.$disconnect();
    });

    let savedFlag: string | undefined;
    let savedMockFlag: string | undefined;

    beforeEach(() => {
      savedFlag = process.env[REAL_GREENHOUSE_SUBMISSION_FLAG];
      savedMockFlag = process.env.JAA_ALLOW_MOCK_SUBMISSION;
      delete process.env[REAL_GREENHOUSE_SUBMISSION_FLAG];
      process.env.JAA_ALLOW_MOCK_SUBMISSION = 'true';
    });

    afterEach(() => {
      if (savedFlag === undefined) delete process.env[REAL_GREENHOUSE_SUBMISSION_FLAG];
      else process.env[REAL_GREENHOUSE_SUBMISSION_FLAG] = savedFlag;
      if (savedMockFlag === undefined) delete process.env.JAA_ALLOW_MOCK_SUBMISSION;
      else process.env.JAA_ALLOW_MOCK_SUBMISSION = savedMockFlag;
    });

    it('the explicit approval action binds an exact content snapshot (identifiers and hashes only)', async () => {
      const { application, version } = await makeApplication();
      const fresh = await freshApplication(application.id);

      expect(fresh.status).toBe('APPROVED');
      expect(fresh.approvedAt).not.toBeNull();

      const snapshot = fresh.approvalSnapshot as Record<string, unknown> | null;
      expect(snapshot).toBeTruthy();
      expect(snapshot!['version']).toBe(1);
      expect(snapshot!['jobId']).toBe(jobId);
      expect(snapshot!['applicationUrl']).toBe(MOCK_URL);
      expect(snapshot!['resumeVersionId']).toBe(version.id);
      expect(String(snapshot!['contentHash'])).toMatch(/^[0-9a-f]{64}$/);
      expect(String(snapshot!['answersHash'])).toMatch(/^[0-9a-f]{64}$/);
      expect(String(snapshot!['resumeContentHash'])).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof snapshot!['boundAt']).toBe('string');

      // The snapshot is a fingerprint - it never contains prepared content.
      const stored = JSON.stringify(snapshot);
      expect(stored).not.toContain(ANSWER_NAME);
      expect(stored).not.toContain(ANSWER_EMAIL);
      expect(stored).not.toContain(COVER_NOTE);

      const approved = await reviewApprovedEvents(application.id);
      expect(approved).toHaveLength(1);
      const metadata = approved[0].metadata as Record<string, unknown>;
      expect(String(metadata['contentHash'])).toBe(String(snapshot!['contentHash']));
      await expectNoContentInEvents(application.id);
    });

    it('re-approving unchanged content is an idempotent no-op', async () => {
      const { application } = await makeApplication();
      const before = await freshApplication(application.id);
      const storedBefore = JSON.stringify(before.approvalSnapshot);

      const result = await approveApplicationForSubmission({
        applicationId: application.id,
        userId: TEST_USER_ID,
      });
      expect(result.status).toBe('APPROVED');
      expect(result.alreadyApproved).toBe(true);
      expect(result.reapproved).toBeFalsy();

      const after = await freshApplication(application.id);
      expect(JSON.stringify(after.approvalSnapshot)).toBe(storedBefore);
      expect(after.approvedAt!.getTime()).toBe(before.approvedAt!.getTime());
      expect(await reviewApprovedEvents(application.id)).toHaveLength(1);
    });

    it('an APPROVED row without a bound snapshot is never submittable (fail closed)', async () => {
      // A fabricated APPROVED flag (row seeded/migrated without the server
      // approval action) must never authorize a submission.
      const { application } = await makeApplication({ approve: false });
      await prisma.application.update({
        where: { id: application.id },
        data: { status: 'APPROVED', approvedAt: new Date() },
      });
      const adapter = new RecordingAdapter(verified('never-used'));

      await expect(
        submitApplication(submitParams(application.id, adapter))
      ).rejects.toMatchObject({ code: 'APPROVAL_NOT_VERIFIED' });

      // Nothing was sent and nothing was claimed.
      expect(adapter.contexts).toHaveLength(0);
      expect(
        await prisma.applicationEvent.count({
          where: { applicationId: application.id, eventType: 'SUBMISSION_STARTED' },
        })
      ).toBe(0);

      // The application is back to "awaiting approval" - a NEW explicit
      // approval is always required.
      const fresh = await freshApplication(application.id);
      expect(fresh.status).toBe('READY_FOR_REVIEW');
      expect(fresh.errorCode).toBe('APPROVAL_NOT_VERIFIED');
      expect(fresh.approvalSnapshot).toBeNull();
      expect(fresh.approvedAt).toBeNull();
    });

    it('an answer edited after approval refuses the submission and invalidates the approval (drift: ANSWERS)', async () => {
      const { application, questionName } = await makeApplication();
      await prisma.applicationAnswer.update({
        where: { questionId: questionName.id },
        data: { answer: EDITED_ANSWER },
      });
      const adapter = new RecordingAdapter(verified('never-used'));

      await expect(
        submitApplication(submitParams(application.id, adapter))
      ).rejects.toMatchObject({ code: 'APPROVAL_STALE' });

      expect(adapter.contexts).toHaveLength(0);
      expect(
        await prisma.applicationEvent.count({
          where: { applicationId: application.id, eventType: 'SUBMISSION_STARTED' },
        })
      ).toBe(0);

      const fresh = await freshApplication(application.id);
      expect(fresh.status).toBe('READY_FOR_REVIEW');
      expect(fresh.errorCode).toBe('APPROVAL_STALE');
      expect(fresh.approvalSnapshot).toBeNull();
      expect(fresh.approvedAt).toBeNull();

      // The user is told WHAT changed - component names only, never content.
      const event = await invalidationEvent(application.id);
      expect(event).toBeTruthy();
      const metadata = event!.metadata as Record<string, unknown>;
      expect(metadata['code']).toBe('APPROVAL_STALE');
      expect(metadata['drift']).toEqual(['ANSWERS']);
      expect(JSON.stringify(event!.metadata)).not.toContain(EDITED_ANSWER);
    });

    it('a resume edited after approval refuses the submission (drift: RESUME)', async () => {
      const { application, version } = await makeApplication();
      await prisma.resumeVersion.update({
        where: { id: version.id },
        data: { extractedText: 'Resume content rewritten after the approval' },
      });
      const adapter = new RecordingAdapter(verified('never-used'));

      await expect(
        submitApplication(submitParams(application.id, adapter))
      ).rejects.toMatchObject({ code: 'APPROVAL_STALE' });

      expect(adapter.contexts).toHaveLength(0);
      const fresh = await freshApplication(application.id);
      expect(fresh.status).toBe('READY_FOR_REVIEW');
      expect(fresh.errorCode).toBe('APPROVAL_STALE');

      const event = await invalidationEvent(application.id);
      expect((event!.metadata as Record<string, unknown>)['drift']).toEqual(['RESUME']);
    });

    it('a changed submission target refuses the submission (drift: TARGET)', async () => {
      const { application } = await makeApplication();
      await prisma.application.update({
        where: { id: application.id },
        data: { applicationUrl: MOCK_URL_OTHER },
      });
      const adapter = new RecordingAdapter(verified('never-used'));

      await expect(
        submitApplication(submitParams(application.id, adapter))
      ).rejects.toMatchObject({ code: 'APPROVAL_STALE' });

      expect(adapter.contexts).toHaveLength(0);
      const fresh = await freshApplication(application.id);
      expect(fresh.status).toBe('READY_FOR_REVIEW');
      expect(fresh.errorCode).toBe('APPROVAL_STALE');

      const event = await invalidationEvent(application.id);
      expect((event!.metadata as Record<string, unknown>)['drift']).toEqual(['TARGET']);
    });

    it('re-approval after drift rebinds the snapshot and the submission sends exactly the newly approved content', async () => {
      const { application, questionName } = await makeApplication();
      const first = await freshApplication(application.id);
      const firstHash = (first.approvalSnapshot as Record<string, unknown>)['contentHash'];

      await prisma.applicationAnswer.update({
        where: { questionId: questionName.id },
        data: { answer: EDITED_ANSWER },
      });
      const reapproval = await approveApplicationForSubmission({
        applicationId: application.id,
        userId: TEST_USER_ID,
      });
      expect(reapproval.status).toBe('APPROVED');
      expect(reapproval.alreadyApproved).toBe(false);
      expect(reapproval.reapproved).toBe(true);

      const rebound = await freshApplication(application.id);
      expect(
        (rebound.approvalSnapshot as Record<string, unknown>)['contentHash']
      ).not.toBe(firstHash);

      const adapter = new RecordingAdapter(verified('mock-appr-reapprove'));
      const result = await submitApplication(submitParams(application.id, adapter));
      expect(result.outcome).toBe('SUBMITTED');

      // What was sent is exactly the newly approved content.
      const fills = adapter.contexts[0].fieldFills ?? [];
      const nameFill = fills.find((fill) => fill.questionId === questionName.id);
      expect(nameFill?.value).toBe(EDITED_ANSWER);
      expect(JSON.stringify(fills)).not.toContain(ANSWER_NAME);

      const fresh = await freshApplication(application.id);
      expect(fresh.status).toBe('SUBMITTED');
      expect(fresh.externalApplicationId).toBe('mock-appr-reapprove');
      await expectNoContentInEvents(application.id);
    });

    it('content changed while the request is being built cannot alter what is sent (claim->fill hand-over)', async () => {
      const { application, questionName } = await makeApplication();

      // The "concurrent writer": the answer row changes at request time -
      // AFTER the attempt claim verified and handed over the content.
      const adapter = new RecordingAdapter(verified('mock-appr-handover'), async () => {
        await prisma.applicationAnswer.update({
          where: { questionId: questionName.id },
          data: { answer: MID_FLIGHT_EDIT },
        });
      });

      const result = await submitApplication(submitParams(application.id, adapter));
      expect(result.outcome).toBe('SUBMITTED');

      // The request carried the approved snapshot values - not the value the
      // row was changed to mid-flight.
      const fills = adapter.contexts[0].fieldFills ?? [];
      const nameFill = fills.find((fill) => fill.questionId === questionName.id);
      expect(nameFill?.value).toBe(ANSWER_NAME);

      // (And the mid-flight write really happened - the row holds it.)
      const row = await prisma.applicationAnswer.findUnique({
        where: { questionId: questionName.id },
      });
      expect(row!.answer).toBe(MID_FLIGHT_EDIT);
    });

    it('a regeneration that changes no answer text leaves the approval intact and submittable', async () => {
      const { application } = await makeApplication();
      const before = await freshApplication(application.id);
      const storedBefore = JSON.stringify(before.approvalSnapshot);

      const generation = await generateApplicationAnswers({
        applicationId: application.id,
        userId: TEST_USER_ID,
        aiProvider: null,
      });
      // Every answer is user approved - nothing is ever overwritten.
      expect(generation.skippedApproved).toBe(3);

      const after = await freshApplication(application.id);
      expect(after.status).toBe('APPROVED');
      expect(JSON.stringify(after.approvalSnapshot)).toBe(storedBefore);
      expect(await reviewApprovedEvents(application.id)).toHaveLength(1);

      // The approval is still valid: the submission proceeds normally.
      const adapter = new RecordingAdapter(verified('mock-appr-noop'));
      const result = await submitApplication(submitParams(application.id, adapter));
      expect(result.outcome).toBe('SUBMITTED');
      expect(adapter.contexts).toHaveLength(1);
    });

    it('a regeneration that changes answer text invalidates the approval (drift: ANSWERS)', async () => {
      // The cover note answer is UNAPPROVED, so regeneration may write it -
      // and the seeded sentinel makes the text change deterministic.
      const { application } = await makeApplication({
        coverAnswer: { text: STALE_SENTINEL, approved: false },
      });

      const generation = await generateApplicationAnswers({
        applicationId: application.id,
        userId: TEST_USER_ID,
        aiProvider: null,
      });
      expect(generation.skippedApproved).toBe(2);

      // Approved content changed -> the approval is invalidated, never
      // silently kept. The user must approve the NEW content.
      const fresh = await freshApplication(application.id);
      expect(fresh.status).toBe('READY_FOR_REVIEW');
      expect(fresh.errorCode).toBe('APPROVAL_STALE');
      expect(fresh.approvalSnapshot).toBeNull();

      const event = await invalidationEvent(application.id);
      expect((event!.metadata as Record<string, unknown>)['drift']).toEqual(['ANSWERS']);
      expect(JSON.stringify(event!.metadata)).not.toContain(STALE_SENTINEL);
    });

    it('application content is immutable while SUBMITTING or SUBMITTED', async () => {
      const { application } = await makeApplication({ approve: false });

      await prisma.application.update({
        where: { id: application.id },
        data: { status: 'SUBMITTING' },
      });
      await expect(
        generateApplicationAnswers({
          applicationId: application.id,
          userId: TEST_USER_ID,
          aiProvider: null,
        })
      ).rejects.toMatchObject({ code: 'APPLICATION_TERMINAL' });

      await prisma.application.update({
        where: { id: application.id },
        data: { status: 'SUBMITTED' },
      });
      await expect(
        generateApplicationAnswers({
          applicationId: application.id,
          userId: TEST_USER_ID,
          aiProvider: null,
        })
      ).rejects.toMatchObject({ code: 'APPLICATION_TERMINAL' });
    });

    it('an unknown submission outcome freezes the lifecycle: no reset, no resubmission', async () => {
      const { application } = await makeApplication();

      // "Submitted" without any verifiable confirmation: the outcome is
      // genuinely unknown. The workflow records it as such (the attempt
      // marker stays deliberately UNRESOLVED) and refuses to continue.
      const adapter = new RecordingAdapter({ httpStatus: 200 });
      await expect(
        submitApplication(submitParams(application.id, adapter))
      ).rejects.toMatchObject({ code: 'SUBMISSION_OUTCOME_UNKNOWN' });
      expect(adapter.contexts).toHaveLength(1);

      const afterFirst = await freshApplication(application.id);
      expect(afterFirst.status).toBe('FAILED');
      expect(afterFirst.errorCode).toBe('SUBMISSION_OUTCOME_UNKNOWN');

      // The ledger exposes the unresolved attempt.
      const unresolvedId = await findUnresolvedSubmissionAttempt(application.id);
      expect(unresolvedId).toBeTruthy();
      const batch = await findUnresolvedSubmissionAttempts([application.id]);
      expect(batch.get(application.id)).toBe(unresolvedId);
      expect(await hasSubmissionAttemptHistory(application.id)).toBe(true);

      // RESET GUARD: the application must NEVER return to a fresh
      // preparation state (which would erase the "requires resolution"
      // signal and could lead to a second submission).
      await expect(
        checkPreparationEligibility({
          applicationId: application.id,
          userId: TEST_USER_ID,
          registry: registryWith(new RecordingAdapter(verified('never-used'))),
        })
      ).rejects.toMatchObject({ code: 'SUBMISSION_OUTCOME_UNKNOWN' });
      const afterPrepare = await freshApplication(application.id);
      expect(afterPrepare.status).toBe('FAILED');
      expect(afterPrepare.errorCode).toBe('SUBMISSION_OUTCOME_UNKNOWN');

      // The submission gate refuses it too.
      await expect(
        checkSubmissionEligibility({
          applicationId: application.id,
          userId: TEST_USER_ID,
          registry: registryWith(new RecordingAdapter(verified('never-used'))),
        })
      ).rejects.toMatchObject({ code: 'SUBMISSION_OUTCOME_UNKNOWN' });

      // And a NEW submission attempt is never made: no second request, no
      // second attempt marker.
      const retryAdapter = new RecordingAdapter(verified('never-used'));
      await expect(
        submitApplication(submitParams(application.id, retryAdapter))
      ).rejects.toMatchObject({ code: 'SUBMISSION_OUTCOME_UNKNOWN' });
      expect(retryAdapter.contexts).toHaveLength(0);
      expect(
        await prisma.applicationEvent.count({
          where: { applicationId: application.id, eventType: 'SUBMISSION_STARTED' },
        })
      ).toBe(1);

      // The user-facing status says exactly this (never a success).
      const status = await getSubmissionStatus(afterFirst);
      expect(status.phase).toBe('OUTCOME_UNKNOWN');
      expect(status.code).toBe('SUBMISSION_OUTCOME_UNKNOWN');
      expect(status.safeToRetry).toBe(false);
      expect(status.requiresHumanResolution).toBe(true);
    });

    it('a FAILED application without submission attempt history is never submittable', async () => {
      // FAILED without any attempt marker is a failed PREPARATION - it is
      // not a retry of a submission and must never claim a fresh attempt.
      const { application } = await makeApplication();
      await prisma.application.update({
        where: { id: application.id },
        data: { status: 'FAILED', errorCode: 'PREPARATION_FAILED' },
      });
      const adapter = new RecordingAdapter(verified('never-used'));

      const result = await submitApplication(submitParams(application.id, adapter));
      expect(result.outcome).toBe('SKIPPED');
      expect(result.outcome === 'SKIPPED' && result.reason).toBe('NOT_CLAIMABLE');

      expect(adapter.contexts).toHaveLength(0);
      expect(
        await prisma.applicationEvent.count({
          where: { applicationId: application.id, eventType: 'SUBMISSION_STARTED' },
        })
      ).toBe(0);
      expect(await findUnresolvedSubmissionAttempt(application.id)).toBeNull();
      const fresh = await freshApplication(application.id);
      expect(fresh.status).toBe('FAILED');
    });
  }
);
