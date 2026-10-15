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
  REAL_GREENHOUSE_SUBMISSION_FLAG,
} = await import('@jaa/core');
const { AtsRegistry } = await import('@jaa/ats');
type AtsAdapter = import('@jaa/ats').AtsAdapter;
type AtsSubmissionContext = import('@jaa/ats').AtsSubmissionContext;
type AtsSubmissionResult = import('@jaa/ats').AtsSubmissionResult;

/**
 * Phase 15B - core submission workflow: MOCK / REAL mode dispatch.
 *
 * These tests verify the mode plumbing of `submitApplication` (mode
 * decision, in-memory field fills in every mode, approved-resume file,
 * nullable provider reference, fail-closed capability) WITHOUT ANY REAL
 * SUBMISSION: the recording stub adapter never touches the network or the
 * page. Prepared answers travel in memory only - queue payloads, the MOCK
 * envelope, and event metadata stay content-free. The live real-submission
 * suite (apps/api/tests/real) is gated separately.
 */

const TEST_USER_ID = 'subm-modes-user';

/** Distinctive synthetic values - used to prove they never leak to events. */
const ANSWER_NAME = 'Zorblatt';
const ANSWER_EMAIL = 'zorblatt-candidate@example.com';

class RecordingAdapter implements AtsAdapter {
  readonly provider = 'GREENHOUSE';
  readonly name = 'Recording test adapter';
  readonly contexts: AtsSubmissionContext[] = [];

  constructor(private readonly result: Partial<AtsSubmissionResult>) {}

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

let counter = 0;
let jobId: string;

async function makeApplication(applicationUrl: string) {
  counter += 1;
  const resume = await prisma.resume.create({
    data: {
      userId: TEST_USER_ID,
      name: `SubmModes resume ${counter}`,
      originalFileName: `subm-modes-${counter}.txt`,
      fileType: 'pdf',
      storageKey: `test/subm-modes-${counter}.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
    },
  });
  const version = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: path.resolve(`test/subm-modes-${counter}-v1.txt`),
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
  // An unanswered question must never produce a fill.
  const questionUnanswered = await prisma.applicationQuestion.create({
    data: {
      applicationId: application.id,
      externalFieldId: 'cover_note',
      label: 'Cover Note',
      normalizedLabel: 'cover_note',
      fieldType: 'TEXTAREA',
      required: false,
      locator: { cssSelector: '#cover_note', attributes: {} } as object,
    },
  });

  // Phase 15D: approval binds the exact content snapshot. The explicit
  // approval action runs AFTER the questions/answers exist, exactly like the
  // product flow - a fabricated APPROVED flag is never submittable.
  await approveApplicationForSubmission({
    applicationId: application.id,
    userId: TEST_USER_ID,
  });

  return { application, version, questionName, questionEmail, questionUnanswered };
}

const FLAG = REAL_GREENHOUSE_SUBMISSION_FLAG;
const REAL_URL = `https://job-boards.greenhouse.io/testco/jobs/phase15b-modes`;
const MOCK_URL = 'http://127.0.0.1:9111/applications/new';
const SUCCESS_URL = 'https://job-boards.greenhouse.io/testco/thank_you';

let savedFlag: string | undefined;
let savedMockFlag: string | undefined;

describe.skipIf(!HAS_DB)('application submission modes (database integration, zero network)', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: 'subm-modes-user@test.local', name: 'Subm Modes User' },
    });
    const job = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'GREENHOUSE',
        url: `https://example.com/subm-modes-job-${Date.now()}`,
        company: 'Subm Modes Co',
        title: 'Subm Modes Role',
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

  beforeEach(() => {
    savedFlag = process.env[FLAG];
    savedMockFlag = process.env.JAA_ALLOW_MOCK_SUBMISSION;
    delete process.env[FLAG];
    delete process.env.JAA_ALLOW_MOCK_SUBMISSION;
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
    if (savedMockFlag === undefined) delete process.env.JAA_ALLOW_MOCK_SUBMISSION;
    else process.env.JAA_ALLOW_MOCK_SUBMISSION = savedMockFlag;
  });

  it('REAL mode passes prepared answers and the approved resume to the adapter, in memory only', async () => {
    process.env[FLAG] = 'true';
    const { application, version, questionName, questionEmail, questionUnanswered } =
      await makeApplication(REAL_URL);
    const adapter = new RecordingAdapter({
      externalApplicationId: 'prov-ref-1',
      confirmation: {
        method: 'PROVIDER_ID',
        reference: 'prov-ref-1',
        url: SUCCESS_URL,
      },
      confirmationUrl: SUCCESS_URL,
    });

    const result = await submitApplication({
      applicationId: application.id,
      userId: TEST_USER_ID,
      registry: registryWith(adapter),
      headless: true,
    });

    expect(result.outcome).toBe('SUBMITTED');

    const ctx = adapter.contexts[0];
    expect(ctx.submissionMode).toBe('REAL');
    const fills = ctx.fieldFills ?? [];
    expect(fills.map((fill) => fill.questionId).sort()).toEqual(
      [questionName.id, questionEmail.id].sort()
    );
    const nameFill = fills.find((fill) => fill.questionId === questionName.id);
    expect(nameFill?.value).toBe(ANSWER_NAME);
    expect(nameFill?.locator?.cssSelector).toBe('#first_name');
    expect(nameFill?.fieldType).toBe('TEXT');
    const emailFill = fills.find((fill) => fill.questionId === questionEmail.id);
    expect(emailFill?.value).toBe(ANSWER_EMAIL);
    expect(fills.some((fill) => fill.questionId === questionUnanswered.id)).toBe(false);
    expect(ctx.resumeFile).toBe(version.filePath);
    expect(path.isAbsolute(ctx.resumeFile ?? '')).toBe(true);

    const fresh = await prisma.application.findUnique({ where: { id: application.id } });
    expect(fresh!.status).toBe('SUBMITTED');
    expect(fresh!.externalApplicationId).toBe('prov-ref-1');

    const events = await prisma.applicationEvent.findMany({
      where: { applicationId: application.id },
    });
    const completed = events.find((e) => e.eventType === 'SUBMISSION_COMPLETED');
    expect(completed).toBeTruthy();
    const metadata = JSON.stringify(completed!.metadata);
    expect(completed!.metadata).toMatchObject({
      confirmationId: 'prov-ref-1',
      confirmationMethod: 'PROVIDER_ID',
    });
    // The audit trail carries IDs, codes and URLs only - prepared answers
    // never appear in event metadata.
    expect(metadata).not.toContain(ANSWER_NAME);
    expect(metadata).not.toContain(ANSWER_EMAIL);
    for (const event of events) {
      const eventMetadata = JSON.stringify(event.metadata);
      expect(eventMetadata).not.toContain(ANSWER_NAME);
      expect(eventMetadata).not.toContain(ANSWER_EMAIL);
    }
  });

  it('a confirmed success page without a provider reference still verifies as SUBMITTED (reference stays null)', async () => {
    process.env[FLAG] = 'true';
    const { application } = await makeApplication(REAL_URL);
    const adapter = new RecordingAdapter({
      externalApplicationId: null,
      confirmation: { method: 'SUCCESS_PAGE', reference: null, url: SUCCESS_URL },
      confirmationUrl: SUCCESS_URL,
    });

    const result = await submitApplication({
      applicationId: application.id,
      userId: TEST_USER_ID,
      registry: registryWith(adapter),
      headless: true,
    });

    expect(result.outcome).toBe('SUBMITTED');
    const fresh = await prisma.application.findUnique({ where: { id: application.id } });
    expect(fresh!.status).toBe('SUBMITTED');
    // Honest: no provider id was exposed, so none is stored.
    expect(fresh!.externalApplicationId).toBeNull();

    const completed = await prisma.applicationEvent.findFirst({
      where: { applicationId: application.id, eventType: 'SUBMISSION_COMPLETED' },
    });
    expect(completed!.metadata).toMatchObject({ confirmationMethod: 'SUCCESS_PAGE' });
    expect(completed!.metadata).toMatchObject({ confirmationId: null });
  });

  it('MOCK mode carries prepared values in memory only; payloads stay content-free', async () => {
    process.env.JAA_ALLOW_MOCK_SUBMISSION = 'true';
    const { application, version, questionName, questionEmail, questionUnanswered } =
      await makeApplication(MOCK_URL);
    const adapter = new RecordingAdapter({
      externalApplicationId: 'mock-1',
      httpStatus: 200,
    });

    const result = await submitApplication({
      applicationId: application.id,
      userId: TEST_USER_ID,
      registry: registryWith(adapter),
      headless: true,
      allowPrivateUrls: true,
    });

    expect(result.outcome).toBe('SUBMITTED');
    const ctx = adapter.contexts[0];
    expect(ctx.submissionMode).toBe('MOCK');
    // Prepared values are available to the adapter in MOCK mode too: a
    // documented submission API must run its client-side required checks
    // against real answers. They stay in memory - the MOCK envelope itself
    // carries identifiers and counts only (asserted on the wire in the e2e
    // suites), and no queue payload or event metadata contains them.
    const fills = ctx.fieldFills ?? [];
    expect(fills.map((fill) => fill.questionId).sort()).toEqual(
      [questionName.id, questionEmail.id].sort()
    );
    expect(fills.find((fill) => fill.questionId === questionName.id)?.value).toBe(ANSWER_NAME);
    expect(fills.some((fill) => fill.questionId === questionUnanswered.id)).toBe(false);
    expect(ctx.resumeFile).toBe(version.filePath);

    const fresh = await prisma.application.findUnique({ where: { id: application.id } });
    expect(fresh!.status).toBe('SUBMITTED');
    expect(fresh!.externalApplicationId).toBe('mock-1');

    const events = await prisma.applicationEvent.findMany({
      where: { applicationId: application.id },
    });
    for (const event of events) {
      const eventMetadata = JSON.stringify(event.metadata);
      expect(eventMetadata).not.toContain(ANSWER_NAME);
      expect(eventMetadata).not.toContain(ANSWER_EMAIL);
    }
  });

  it('a REAL target without the server capability is refused before ANY bookkeeping (fail closed)', async () => {
    // JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED is deliberately left unset.
    const { application } = await makeApplication(REAL_URL);
    const adapter = new RecordingAdapter({ externalApplicationId: 'never-used' });

    await expect(
      submitApplication({
        applicationId: application.id,
        userId: TEST_USER_ID,
        registry: registryWith(adapter),
        headless: true,
      })
    ).rejects.toMatchObject({ code: 'BLOCKED_BY_SECURITY_POLICY' });

    // Nothing was submitted and nothing was claimed: no attempt marker, no
    // status change, and the adapter was never invoked.
    expect(adapter.contexts).toHaveLength(0);
    const fresh = await prisma.application.findUnique({ where: { id: application.id } });
    expect(fresh!.status).toBe('APPROVED');
    expect(fresh!.submittedAt).toBeNull();
    const started = await prisma.applicationEvent.count({
      where: { applicationId: application.id, eventType: 'SUBMISSION_STARTED' },
    });
    expect(started).toBe(0);
  });
});
