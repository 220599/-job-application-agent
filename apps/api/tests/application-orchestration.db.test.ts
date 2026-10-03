import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Load DATABASE_URL before @jaa/database instantiates Prisma (repo convention).
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/jaa_dev';

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { prisma } = await import('@jaa/database');
const {
  requestApplicationPreparation,
  getApplicationAutomationRun,
  cancelApplicationAutomationRun,
  claimPreparationRun,
  touchAutomationRun,
  checkPreparationEligibility,
  OrchestrationError,
} = await import('@jaa/core');
type PreparationJobPayload = import('@jaa/shared').PreparationJobPayload;

const TEST_USER_ID = 'orchestr-db-user';
const INTRUDER_ID = 'orchestr-db-intruder';

let counter = 0;
let jobId: string;

interface MakeAppOptions {
  reviewStatus?: 'PENDING' | 'APPROVED' | 'REJECTED';
  tailoringValidation?: 'PASSED' | 'FAILED' | null;
  status?: string;
  applicationUrl?: string | null;
}

async function makeApplication(opts: MakeAppOptions = {}) {
  counter += 1;
  const resume = await prisma.resume.create({
    data: {
      userId: TEST_USER_ID,
      name: `Orchestr resume ${counter}`,
      originalFileName: `orchestr-${counter}.txt`,
      fileType: 'pdf',
      storageKey: `test/orchestr-${counter}.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
    },
  });
  const source = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: `test/orchestr-${counter}-v1.txt`,
      source: 'ORIGINAL',
    },
  });
  const tailoring =
    opts.tailoringValidation === null
      ? null
      : {
          sourceVersionId: source.id,
          jobId,
          strategy: 'JOB_ALIGNED_V1',
          aiGenerated: true,
          provider: 'mock',
          validationStatus: opts.tailoringValidation ?? 'PASSED',
          contentFormat: 'STRUCTURED_JSON',
          promptVersion: 'v1',
          generatedAt: '2026-10-03T10:00:00.000Z',
        };
  const version = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 2,
      filePath: `test/orchestr-${counter}-v2.txt`,
      source: tailoring ? 'TAILORED' : 'ORIGINAL',
      reviewStatus: opts.reviewStatus ?? 'PENDING',
      tailoring: (tailoring ?? undefined) as object | undefined,
    },
  });
  const application = await prisma.application.create({
    data: {
      userId: TEST_USER_ID,
      jobId,
      resumeVersionId: version.id,
      ats: 'GREENHOUSE',
      applicationUrl:
        opts.applicationUrl === undefined
          ? `https://job-boards.greenhouse.io/testco/jobs/${Date.now()}-${counter}`
          : opts.applicationUrl,
      status: (opts.status ?? 'DISCOVERED') as never,
    },
  });
  return { resume, source, version, application };
}

type Capture = { payloads: PreparationJobPayload[]; enqueue: (p: PreparationJobPayload) => Promise<void> };

function capturingEnqueue(): Capture {
  const payloads: PreparationJobPayload[] = [];
  return {
    payloads,
    enqueue: async (p) => {
      payloads.push(p);
    },
  };
}

describe.skipIf(!HAS_DB)('application orchestration (database integration)', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: 'orchestr-db-user@test.local', name: 'Orchestr DB User' },
    });
    await prisma.user.upsert({
      where: { id: INTRUDER_ID },
      update: {},
      create: { id: INTRUDER_ID, email: 'orchestr-db-intruder@test.local', name: 'Intruder' },
    });
    const job = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'GREENHOUSE',
        url: `https://example.com/orchestr-db-job-${Date.now()}`,
        company: 'Orchestr Co',
        title: 'Orchestr Role',
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
    await prisma.user.deleteMany({ where: { id: { in: [TEST_USER_ID, INTRUDER_ID] } } });
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------
  // Eligibility matrix
  // ---------------------------------------------------------------------

  it('queues an eligible application with an identifiers-only payload', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    const cap = capturingEnqueue();

    const result = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
    });

    expect(result.reused).toBe(false);
    expect(result.enqueued).toBe(true);
    expect(result.automationRun.status).toBe('QUEUED');
    expect(result.automationRun.provider).toBe('GREENHOUSE');
    expect(cap.payloads).toHaveLength(1);
    expect(Object.keys(cap.payloads[0]).sort()).toEqual(['applicationId', 'automationRunId']);
    expect(cap.payloads[0]).toEqual({
      applicationId: application.id,
      automationRunId: result.automationRun.id,
    });

    // Queueing never advances the application - the worker does that later.
    const fresh = await prisma.application.findUnique({ where: { id: application.id } });
    expect(fresh!.status).toBe('DISCOVERED');
  });

  it('refuses PENDING and REJECTED resume versions', async () => {
    for (const reviewStatus of ['PENDING', 'REJECTED'] as const) {
      const { application } = await makeApplication({ reviewStatus });
      const cap = capturingEnqueue();
      await expect(
        requestApplicationPreparation({
          applicationId: application.id,
          userId: TEST_USER_ID,
          enqueue: cap.enqueue,
        })
      ).rejects.toMatchObject({ code: 'RESUME_NOT_APPROVED' });
      expect(cap.payloads).toHaveLength(0);
      expect(await prisma.automationRun.findUnique({ where: { applicationId: application.id } })).toBeNull();
    }
  });

  it('refuses resume versions whose tailoring validation failed', async () => {
    const { application } = await makeApplication({
      reviewStatus: 'APPROVED',
      tailoringValidation: 'FAILED',
    });
    await expect(
      requestApplicationPreparation({
        applicationId: application.id,
        userId: TEST_USER_ID,
        enqueue: capturingEnqueue().enqueue,
      })
    ).rejects.toMatchObject({ code: 'TAILORING_NOT_VALIDATED' });
  });

  it('refuses terminal applications', async () => {
    for (const status of ['SUBMITTING', 'SUBMITTED', 'REJECTED', 'WITHDRAWN', 'OFFER']) {
      const { application } = await makeApplication({ reviewStatus: 'APPROVED', status });
      await expect(
        requestApplicationPreparation({
          applicationId: application.id,
          userId: TEST_USER_ID,
          enqueue: capturingEnqueue().enqueue,
        })
      ).rejects.toMatchObject({ code: 'APPLICATION_TERMINAL' });
    }
  });

  it('refuses statuses beyond the Phase 13 preparation scope', async () => {
    for (const status of ['FORM_FILLED', 'READY_FOR_REVIEW', 'APPROVED']) {
      const { application } = await makeApplication({ reviewStatus: 'APPROVED', status });
      await expect(
        requestApplicationPreparation({
          applicationId: application.id,
          userId: TEST_USER_ID,
          enqueue: capturingEnqueue().enqueue,
        })
      ).rejects.toMatchObject({ code: 'APPLICATION_STATE_NOT_PREPARABLE' });
    }
  });

  it('refuses missing/invalid application URLs and unsupported ATS providers', async () => {
    const missing = await makeApplication({ reviewStatus: 'APPROVED', applicationUrl: null });
    await expect(
      requestApplicationPreparation({
        applicationId: missing.application.id,
        userId: TEST_USER_ID,
        enqueue: capturingEnqueue().enqueue,
      })
    ).rejects.toMatchObject({ code: 'APPLICATION_URL_MISSING' });

    const invalid = await makeApplication({
      reviewStatus: 'APPROVED',
      applicationUrl: 'not-a-url',
    });
    await expect(
      requestApplicationPreparation({
        applicationId: invalid.application.id,
        userId: TEST_USER_ID,
        enqueue: capturingEnqueue().enqueue,
      })
    ).rejects.toMatchObject({ code: 'INVALID_APPLICATION_URL' });

    const unsupported = await makeApplication({
      reviewStatus: 'APPROVED',
      applicationUrl: 'https://careers.unknown-ats.example/apply/1',
    });
    await expect(
      requestApplicationPreparation({
        applicationId: unsupported.application.id,
        userId: TEST_USER_ID,
        enqueue: capturingEnqueue().enqueue,
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ATS' });
  });

  it('never leaks existence to other users', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    await expect(
      requestApplicationPreparation({
        applicationId: application.id,
        userId: INTRUDER_ID,
        enqueue: capturingEnqueue().enqueue,
      })
    ).rejects.toMatchObject({ code: 'APPLICATION_NOT_FOUND' });

    await expect(
      getApplicationAutomationRun({ applicationId: application.id, userId: INTRUDER_ID })
    ).rejects.toMatchObject({ code: 'APPLICATION_NOT_FOUND' });

    await expect(
      cancelApplicationAutomationRun({ applicationId: application.id, userId: INTRUDER_ID })
    ).rejects.toMatchObject({ code: 'APPLICATION_NOT_FOUND' });

    // Missing application behaves identically.
    await expect(
      requestApplicationPreparation({
        applicationId: 'nope',
        userId: TEST_USER_ID,
        enqueue: capturingEnqueue().enqueue,
      })
    ).rejects.toMatchObject({ code: 'APPLICATION_NOT_FOUND' });
  });

  // ---------------------------------------------------------------------
  // Idempotency & concurrency
  // ---------------------------------------------------------------------

  it('repeated requests reuse the active run and never enqueue duplicates', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    const cap = capturingEnqueue();

    const first = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
    });
    const second = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
    });

    expect(second.reused).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(second.automationRun.id).toBe(first.automationRun.id);
    expect(cap.payloads).toHaveLength(1);
    expect(await prisma.automationRun.count({ where: { applicationId: application.id } })).toBe(1);
  });

  it('concurrent requests collapse into one run and one job (DB-level guard)', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    const cap = capturingEnqueue();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        requestApplicationPreparation({
          applicationId: application.id,
          userId: TEST_USER_ID,
          enqueue: cap.enqueue,
        })
      )
    );

    const ids = new Set(results.map((r) => r.automationRun.id));
    expect(ids.size).toBe(1);
    expect(cap.payloads).toHaveLength(1);
    expect(await prisma.automationRun.count({ where: { applicationId: application.id } })).toBe(1);
  });

  it('re-queues after a failed run and after a stale RUNNING run (crash recovery)', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    const cap = capturingEnqueue();

    const first = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
    });

    // Failed run -> a fresh attempt may be queued again.
    await prisma.automationRun.update({
      where: { id: first.automationRun.id },
      data: { status: 'FAILED', completedAt: new Date(), errorMessage: 'boom' },
    });
    const second = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
    });
    expect(second.automationRun.status).toBe('QUEUED');
    expect(second.automationRun.errorMessage).toBeNull();
    expect(cap.payloads).toHaveLength(2);

    // A RUNNING run that is still fresh is reused as-is...
    await prisma.automationRun.update({
      where: { id: first.automationRun.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    const active = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
    });
    expect(active.reused).toBe(true);
    expect(cap.payloads).toHaveLength(2);

    // ...but a crashed RUNNING run (no heartbeat within staleMs) is reclaimed.
    await prisma.automationRun.update({
      where: { id: first.automationRun.id },
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });
    const recovered = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
      staleMs: 1_000,
    });
    expect(recovered.reused).toBe(false);
    expect(recovered.automationRun.status).toBe('QUEUED');
    expect(cap.payloads).toHaveLength(3);
  });

  it('marks the run FAILED and throws ENQUEUE_FAILED when the queue is down', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    await expect(
      requestApplicationPreparation({
        applicationId: application.id,
        userId: TEST_USER_ID,
        enqueue: async () => {
          throw new Error('redis gone');
        },
      })
    ).rejects.toMatchObject({ code: 'ENQUEUE_FAILED' });

    const run = await prisma.automationRun.findUnique({
      where: { applicationId: application.id },
    });
    expect(run!.status).toBe('FAILED');
    expect(run!.errorMessage).toContain('ENQUEUE_FAILED');
  });

  // ---------------------------------------------------------------------
  // Run state transitions (worker claim)
  // ---------------------------------------------------------------------

  it('claim transitions are conditional: only one worker can ever win', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    const cap = capturingEnqueue();
    const { automationRun } = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
    });

    // Two workers race the QUEUED -> RUNNING transition.
    const [a, b] = await Promise.all([
      claimPreparationRun({ runId: automationRun.id }),
      claimPreparationRun({ runId: automationRun.id }),
    ]);
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);

    // The loser sees the run as ACTIVE; nothing double-processes.
    const loser = a.claimed ? b : a;
    if (!loser.claimed) expect(loser.reason).toBe('ACTIVE');

    // ACTIVE while RUNNING and fresh.
    const again = await claimPreparationRun({ runId: automationRun.id });
    expect(again.claimed).toBe(false);

    // A crashed RUNNING run (stale) can be reclaimed.
    await prisma.automationRun.update({
      where: { id: automationRun.id },
      data: { updatedAt: new Date(Date.now() - 60 * 60_000) },
    });
    const recovered = await claimPreparationRun({ runId: automationRun.id, staleMs: 1_000 });
    expect(recovered.claimed).toBe(true);
  });

  it('FAILED runs are claimable (bounded BullMQ retry) but CANCELLED/COMPLETED are final', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    const cap = capturingEnqueue();
    const { automationRun } = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
    });

    await prisma.automationRun.update({
      where: { id: automationRun.id },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    expect((await claimPreparationRun({ runId: automationRun.id })).claimed).toBe(true);

    await prisma.automationRun.update({
      where: { id: automationRun.id },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    const cancelled = await claimPreparationRun({ runId: automationRun.id });
    expect(cancelled.claimed).toBe(false);
    if (!cancelled.claimed) expect(cancelled.reason).toBe('CANCELLED');

    await prisma.automationRun.update({
      where: { id: automationRun.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    const completed = await claimPreparationRun({ runId: automationRun.id });
    expect(completed.claimed).toBe(false);
  });

  it('heartbeat (touch) only bumps RUNNING runs', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    const cap = capturingEnqueue();
    const { automationRun } = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
    });
    await prisma.automationRun.update({
      where: { id: automationRun.id },
      data: { status: 'RUNNING', startedAt: new Date(), updatedAt: new Date(0) },
    });
    await touchAutomationRun(automationRun.id);
    const fresh = await prisma.automationRun.findUnique({ where: { id: automationRun.id } });
    expect(fresh!.updatedAt.getTime()).toBeGreaterThan(0);

    await prisma.automationRun.update({
      where: { id: automationRun.id },
      data: { status: 'CANCELLED', updatedAt: new Date(0) },
    });
    await touchAutomationRun(automationRun.id);
    const untouched = await prisma.automationRun.findUnique({ where: { id: automationRun.id } });
    expect(untouched!.updatedAt.getTime()).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Status API + cancellation
  // ---------------------------------------------------------------------

  it('exposes safe automation status and never raw metadata', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: capturingEnqueue().enqueue,
    });

    const view = await getApplicationAutomationRun({
      applicationId: application.id,
      userId: TEST_USER_ID,
    });
    expect(view).toMatchObject({
      applicationId: application.id,
      status: 'QUEUED',
      provider: 'GREENHOUSE',
    });
    expect(view).not.toHaveProperty('metadata');

    // No run yet -> null (not an error).
    const other = await makeApplication({ reviewStatus: 'APPROVED' });
    expect(
      await getApplicationAutomationRun({ applicationId: other.application.id, userId: TEST_USER_ID })
    ).toBeNull();
  });

  it('cancellation is safe and idempotent: QUEUED only', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    const cap = capturingEnqueue();
    const { automationRun } = await requestApplicationPreparation({
      applicationId: application.id,
      userId: TEST_USER_ID,
      enqueue: cap.enqueue,
    });

    const cancelled = await cancelApplicationAutomationRun({
      applicationId: application.id,
      userId: TEST_USER_ID,
    });
    expect(cancelled.changed).toBe(true);
    expect(cancelled.automationRun.status).toBe('CANCELLED');

    // Idempotent: cancelling twice succeeds unchanged.
    const repeat = await cancelApplicationAutomationRun({
      applicationId: application.id,
      userId: TEST_USER_ID,
    });
    expect(repeat.changed).toBe(false);
    expect(repeat.automationRun.status).toBe('CANCELLED');

    // A cancelled run is never processed.
    const claim = await claimPreparationRun({ runId: automationRun.id });
    expect(claim.claimed).toBe(false);

    // A RUNNING run cannot be cancelled (live browser session).
    const running = await makeApplication({ reviewStatus: 'APPROVED' });
    const cap2 = capturingEnqueue();
    const second = await requestApplicationPreparation({
      applicationId: running.application.id,
      userId: TEST_USER_ID,
      enqueue: cap2.enqueue,
    });
    await prisma.automationRun.update({
      where: { id: second.automationRun.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    await expect(
      cancelApplicationAutomationRun({
        applicationId: running.application.id,
        userId: TEST_USER_ID,
      })
    ).rejects.toMatchObject({ code: 'AUTOMATION_NOT_CANCELLABLE' });
  });

  it('cancellation without a run reports AUTOMATION_RUN_NOT_FOUND', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    await expect(
      cancelApplicationAutomationRun({ applicationId: application.id, userId: TEST_USER_ID })
    ).rejects.toMatchObject({ code: 'AUTOMATION_RUN_NOT_FOUND' });
  });

  it('eligibility check is pure orchestration: it never mutates state', async () => {
    const { application } = await makeApplication({ reviewStatus: 'APPROVED' });
    const eligibility = await checkPreparationEligibility({
      applicationId: application.id,
      userId: TEST_USER_ID,
    });
    expect(eligibility.provider).toBe('GREENHOUSE');
    expect(eligibility.application.status).toBe('DISCOVERED');
    expect(await prisma.automationRun.findUnique({ where: { applicationId: application.id } })).toBeNull();
  });

  it('OrchestrationError is recognizable across module boundaries', async () => {
    const { application } = await makeApplication({ reviewStatus: 'PENDING' });
    try {
      await requestApplicationPreparation({
        applicationId: application.id,
        userId: TEST_USER_ID,
        enqueue: capturingEnqueue().enqueue,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
    }
  });
});
