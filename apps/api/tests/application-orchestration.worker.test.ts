import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Load DATABASE_URL before @jaa/database instantiates Prisma (repo convention).
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/jaa_dev';

const HAS_DB = Boolean(process.env.DATABASE_URL);

import type { MockGreenhouseServer } from '../../packages/greenhouse/tests/fixtures/mock-greenhouse-server';

const { prisma } = await import('@jaa/database');
const {
  handlePreparationJob,
  requestApplicationPreparation,
  createPreparationWorker,
  createPreparationRegistry,
  getPreparationQueue,
  closePreparationQueue,
  PREPARATION_JOB_OPTIONS,
} = await import('@jaa/core');
const { AtsError } = await import('@jaa/ats');
const { startMockGreenhouseServer } = await import(
  '../../packages/greenhouse/tests/fixtures/mock-greenhouse-server'
);

const TEST_USER_ID = 'orchestr-worker-user';

let counter = 0;
let jobId: string;
let greenhouse: MockGreenhouseServer | null = null;

function isUnrecoverable(err: unknown): boolean {
  return err instanceof Error && err.name === 'UnrecoverableError';
}

async function makeApplication(opts: { applicationUrl?: string | null; status?: string } = {}) {
  counter += 1;
  const resume = await prisma.resume.create({
    data: {
      userId: TEST_USER_ID,
      name: `Orchestr worker resume ${counter}`,
      originalFileName: `orchestr-worker-${counter}.txt`,
      fileType: 'pdf',
      storageKey: `test/orchestr-worker-${counter}.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
    },
  });
  const source = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: `test/orchestr-worker-${counter}-v1.txt`,
      source: 'ORIGINAL',
    },
  });
  const version = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 2,
      filePath: `test/orchestr-worker-${counter}-v2.txt`,
      source: 'TAILORED',
      reviewStatus: 'APPROVED',
      tailoring: {
        sourceVersionId: source.id,
        jobId,
        strategy: 'JOB_ALIGNED_V1',
        aiGenerated: true,
        provider: 'mock',
        validationStatus: 'PASSED',
        contentFormat: 'STRUCTURED_JSON',
        promptVersion: 'v1',
        generatedAt: '2026-10-03T10:00:00.000Z',
      } as object,
    },
  });
  return prisma.application.create({
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
}

/** Queue an application the way the API does, with a captured payload. */
async function queueApplication(
  applicationId: string,
  registry?: ReturnType<typeof createPreparationRegistry>
) {
  let payload: { applicationId: string; automationRunId: string } | null = null;
  const result = await requestApplicationPreparation({
    applicationId,
    userId: TEST_USER_ID,
    registry,
    enqueue: async (p) => {
      payload = p;
    },
  });
  return { result: result.automationRun, payload: payload! };
}

/** Stub prepareApplication result (no browser) for handler-semantic tests. */
function stubResult(applicationId: string, automationRunId: string) {
  return {
    applicationId,
    status: 'FORM_INSPECTED' as const,
    inspection: null,
    questionsPersisted: 3,
    automationRunId,
    provider: 'GREENHOUSE',
  };
}

describe.skipIf(!HAS_DB)('application preparation worker', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: {
        id: TEST_USER_ID,
        email: 'orchestr-worker-user@test.local',
        name: 'Orchestr Worker User',
      },
    });
    const job = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'GREENHOUSE',
        url: `https://example.com/orchestr-worker-job-${Date.now()}`,
        company: 'Orchestr Worker Co',
        title: 'Orchestr Worker Role',
      },
    });
    jobId = job.id;
  });

  afterAll(async () => {
    await closePreparationQueue();
    await prisma.automationRun.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.applicationEvent.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.application.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.resume.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.job.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.user.deleteMany({ where: { id: TEST_USER_ID } });
    await prisma.$disconnect();
  });

  it('rejects invalid job payloads as unrecoverable (no retries on bad payloads)', async () => {
    for (const payload of [
      null,
      {},
      { applicationId: 'a' },
      { applicationId: 'a', automationRunId: 'r', resumeText: 'sneaky' },
    ]) {
      const err = await handlePreparationJob(payload, {}).catch((e) => e);
      expect(isUnrecoverable(err)).toBe(true);
      expect(err.message).toContain('INVALID_JOB_PAYLOAD');
    }
  });

  it('fails unrecoverably when the AutomationRun does not exist', async () => {
    const application = await makeApplication();
    const err = await handlePreparationJob(
      { applicationId: application.id, automationRunId: 'no-such-run' },
      {}
    ).catch((e) => e);
    expect(isUnrecoverable(err)).toBe(true);
    expect(err.message).toContain('AUTOMATION_RUN_NOT_FOUND');
  });

  it('never mutates a run that belongs to a different application (RUN_MISMATCH)', async () => {
    const a = await makeApplication();
    const b = await makeApplication();
    const { result: runA } = await queueApplication(a.id);
    const { result: runB } = await queueApplication(b.id);

    const err = await handlePreparationJob(
      { applicationId: a.id, automationRunId: runB.id }, // cross-wired payload
      {}
    ).catch((e) => e);
    expect(isUnrecoverable(err)).toBe(true);
    expect(err.message).toContain('RUN_MISMATCH');

    // Run B was untouched - still QUEUED.
    const freshB = await prisma.automationRun.findUnique({ where: { id: runB.id } });
    expect(freshB!.status).toBe('QUEUED');
    void runA;
  });

  it('re-checks eligibility at processing time (revoked approval is unrecoverable)', async () => {
    const application = await makeApplication();
    const { result } = await queueApplication(application.id);
    // Approval revoked between enqueue and processing.
    await prisma.resumeVersion.update({
      where: { id: application.resumeVersionId },
      data: { reviewStatus: 'REJECTED' },
    });

    const err = await handlePreparationJob(
      { applicationId: application.id, automationRunId: result.id },
      {}
    ).catch((e) => e);
    expect(isUnrecoverable(err)).toBe(true);
    expect(err.message).toContain('RESUME_NOT_APPROVED');

    const run = await prisma.automationRun.findUnique({ where: { id: result.id } });
    expect(run!.status).toBe('FAILED');
    expect((run!.metadata as Record<string, unknown>).errorCode).toBe('RESUME_NOT_APPROVED');
  });

  it('non-retryable failures fail the run with a safe error and never retry', async () => {
    const application = await makeApplication();
    const { result } = await queueApplication(application.id);

    const err = await handlePreparationJob(
      { applicationId: application.id, automationRunId: result.id },
      {
        prepare: async () => {
          throw new AtsError(
            'BLOCKED_BY_SECURITY_POLICY',
            'blocked at https://x.example/form?token=super-secret'
          );
        },
      }
    ).catch((e) => e);

    expect(isUnrecoverable(err)).toBe(true);
    expect(err.message).toContain('BLOCKED_BY_SECURITY_POLICY');
    expect(err.message).not.toContain('super-secret');

    const run = await prisma.automationRun.findUnique({ where: { id: result.id } });
    expect(run!.status).toBe('FAILED'); // never stuck in RUNNING
    expect(run!.errorMessage).not.toContain('super-secret');
    expect((run!.metadata as Record<string, unknown>).errorCode).toBe('BLOCKED_BY_SECURITY_POLICY');

    const events = await prisma.applicationEvent.findMany({
      where: { applicationId: application.id, eventType: 'ERROR' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(events.at(-1)!.metadata)).toContain('BLOCKED_BY_SECURITY_POLICY');
  });

  it('retryable failures throw retryable errors; the re-attempt resets state and records RETRY_STARTED', async () => {
    const application = await makeApplication();
    const { result } = await queueApplication(application.id);

    let calls = 0;
    const flakyPrepare = async (params: { applicationId: string }) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:9');
      }
      return stubResult(params.applicationId, result.id);
    };

    // Attempt 1: transient failure -> plain error (BullMQ retries with backoff).
    const err1 = await handlePreparationJob(
      { applicationId: application.id, automationRunId: result.id },
      { attempt: 1, prepare: flakyPrepare }
    ).catch((e) => e);
    expect(isUnrecoverable(err1)).toBe(false);
    expect(err1.name).toBe('RetryablePreparationError');

    const failedRun = await prisma.automationRun.findUnique({ where: { id: result.id } });
    expect(failedRun!.status).toBe('FAILED');
    const failedApp = await prisma.application.findUnique({ where: { id: application.id } });
    expect(failedApp!.status).toBe('FAILED');

    // Attempt 2: re-claims the FAILED run, resets FAILED -> PREPARING, records
    // the retry event, and completes at FORM_INSPECTED.
    const outcome = await handlePreparationJob(
      { applicationId: application.id, automationRunId: result.id },
      { attempt: 2, prepare: flakyPrepare }
    );
    expect(outcome.outcome).toBe('COMPLETED');
    expect(outcome.status).toBe('FORM_INSPECTED');

    const run = await prisma.automationRun.findUnique({ where: { id: result.id } });
    expect(run!.status).toBe('COMPLETED');
    expect(run!.completedAt).not.toBeNull();

    const retries = await prisma.applicationEvent.findMany({
      where: { applicationId: application.id, eventType: 'RETRY_STARTED' },
    });
    expect(retries).toHaveLength(1);
    expect((retries[0].metadata as Record<string, unknown>).attempt).toBe(2);
  });

  it('gives up without further retries when attempts are exhausted', async () => {
    const application = await makeApplication();
    const { result } = await queueApplication(application.id);

    const err = await handlePreparationJob(
      { applicationId: application.id, automationRunId: result.id },
      {
        attempt: 3,
        prepare: async () => {
          throw new Error('socket hang up');
        },
      }
    ).catch((e) => e);
    expect(isUnrecoverable(err)).toBe(true); // no 4th attempt

    const run = await prisma.automationRun.findUnique({ where: { id: result.id } });
    expect(run!.status).toBe('FAILED');
  });

  it('recovers a crashed run instead of leaving it stuck in RUNNING', async () => {
    const application = await makeApplication();
    const { result } = await queueApplication(application.id);

    // Simulate a worker that died mid-run: RUNNING with an old heartbeat.
    await prisma.automationRun.update({
      where: { id: result.id },
      data: { status: 'RUNNING', startedAt: new Date(), updatedAt: new Date(Date.now() - 3600_000) },
    });

    const outcome = await handlePreparationJob(
      { applicationId: application.id, automationRunId: result.id },
      {
        staleMs: 1_000,
        prepare: (params) => Promise.resolve(stubResult(params.applicationId, result.id)),
      }
    );
    expect(outcome.outcome).toBe('COMPLETED');

    const run = await prisma.automationRun.findUnique({ where: { id: result.id } });
    expect(run!.status).toBe('COMPLETED'); // not stuck in RUNNING
  });

  it('a live run is never stolen by a concurrent duplicate job', async () => {
    const application = await makeApplication();
    const { result } = await queueApplication(application.id);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });

    const slowPrepare = async (params: { applicationId: string }) => {
      started();
      await gate;
      return stubResult(params.applicationId, result.id);
    };

    // Worker A: claims and holds the run.
    const inFlight = handlePreparationJob(
      { applicationId: application.id, automationRunId: result.id },
      { prepare: slowPrepare }
    );
    await startedPromise;

    // Worker B (duplicate delivery): must skip, not double-process.
    const duplicate = await handlePreparationJob(
      { applicationId: application.id, automationRunId: result.id },
      {
        prepare: () => {
          throw new Error('must not run');
        },
      }
    );
    expect(duplicate.outcome).toBe('SKIPPED');
    expect(duplicate.reason).toBe('ACTIVE');

    release();
    const outcome = await inFlight;
    expect(outcome.outcome).toBe('COMPLETED');
  });

  it('skips cancelled runs without processing them', async () => {
    const application = await makeApplication();
    const { result } = await queueApplication(application.id);
    await prisma.automationRun.update({
      where: { id: result.id },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });

    const outcome = await handlePreparationJob(
      { applicationId: application.id, automationRunId: result.id },
      {
        prepare: () => {
          throw new Error('must not run');
        },
      }
    );
    expect(outcome.outcome).toBe('SKIPPED');
    expect(outcome.reason).toBe('CANCELLED');
    const app = await prisma.application.findUnique({ where: { id: application.id } });
    expect(app!.status).toBe('DISCOVERED'); // untouched
  });

  it('keeps the application lifecycle capped at FORM_INSPECTED (never submits)', async () => {
    const application = await makeApplication();
    const { result } = await queueApplication(application.id);
    const outcome = await handlePreparationJob(
      { applicationId: application.id, automationRunId: result.id },
      { prepare: (params) => Promise.resolve(stubResult(params.applicationId, result.id)) }
    );

    expect(outcome.status).toBe('FORM_INSPECTED');
    const app = await prisma.application.findUnique({ where: { id: application.id } });
    expect(app!.status).not.toBe('SUBMITTED');
    expect(['DISCOVERED', 'MATCHED', 'PREPARING', 'FORM_INSPECTED']).toContain(app!.status);

    const events = await prisma.applicationEvent.findMany({
      where: { applicationId: application.id },
    });
    for (const event of events) {
      expect(event.eventType).not.toMatch(/^SUBMISSION_/);
    }
    expect(app!.submittedAt).toBeNull();
  });
});

describe.skipIf(!HAS_DB)('BullMQ round trip (existing Docker Redis)', () => {
  let queueName: string;

  beforeAll(async () => {
    queueName = `application-preparation-test-${Date.now()}`;
    // This suite needs its own fixture chain - the previous suite cleaned up.
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: {
        id: TEST_USER_ID,
        email: 'orchestr-worker-user@test.local',
        name: 'Orchestr Worker User',
      },
    });
    const job = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'GREENHOUSE',
        url: `https://example.com/orchestr-worker-job-rt-${Date.now()}`,
        company: 'Orchestr Worker Co',
        title: 'Orchestr Worker Role',
      },
    });
    jobId = job.id;
  });

  afterAll(async () => {
    await closePreparationQueue();
    await prisma.automationRun.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.applicationEvent.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.application.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.resume.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.job.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.user.deleteMany({ where: { id: TEST_USER_ID } });
  });

  it('a queued job flows through BullMQ to the worker and ends COMPLETED at FORM_INSPECTED', async () => {
    const queue = getPreparationQueue(queueName);
    const queueUp = await queue
      .getJobCounts('waiting')
      .then(() => true)
      .catch(() => false);
    if (!queueUp) {
      // No Redis reachable - the unit/DB suites above still cover semantics.
      return;
    }

    greenhouse = await startMockGreenhouseServer();
    const registry = createPreparationRegistry({ extraBoardHosts: ['127.0.0.1'] });
    const application = await makeApplication({ applicationUrl: greenhouse.url });

    const worker = createPreparationWorker({
      queueName,
      registry,
      allowPrivateUrls: true,
      staleMs: 60_000,
      concurrency: 1,
    });

    try {
      const { result, payload } = await queueApplication(application.id, registry);
      // Identifiers only in the Redis payload (security contract).
      expect(Object.keys(payload).sort()).toEqual(['applicationId', 'automationRunId']);
      await queue.add('prepare-application', payload, PREPARATION_JOB_OPTIONS);

      // Wait for the real worker to process the real job.
      const deadline = Date.now() + 90_000;
      let run = await prisma.automationRun.findUnique({ where: { id: result.id } });
      while (run!.status === 'QUEUED' || run!.status === 'RUNNING') {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
        run = await prisma.automationRun.findUnique({ where: { id: result.id } });
      }

      expect(run!.status).toBe('COMPLETED');

      const app = await prisma.application.findUnique({ where: { id: application.id } });
      expect(app!.status).toBe('FORM_INSPECTED'); // lifecycle stops here
      expect(app!.submittedAt).toBeNull();

      const questions = await prisma.applicationQuestion.count({
        where: { applicationId: application.id },
      });
      expect(questions).toBeGreaterThan(0);

      const jobs = await queue.getJobs(['waiting', 'active', 'completed', 'failed']);
      for (const job of jobs) {
        expect(Object.keys(job.data as object).sort()).toEqual([
          'applicationId',
          'automationRunId',
        ]);
      }
    } finally {
      await worker.close();
      if (greenhouse) {
        await greenhouse.close();
        greenhouse = null;
      }
    }
  }, 120_000);
});
