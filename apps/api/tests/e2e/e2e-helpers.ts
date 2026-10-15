/**
 * Phase 14 - shared end-to-end test utilities.
 *
 * These helpers wire up the REAL production pieces for the E2E suites:
 *   - the real Express applications router (the real prepare endpoint),
 *   - the real BullMQ preparation queue and worker (@jaa/core),
 *   - the real database fixtures (user -> profile -> resume -> approved
 *     ResumeVersion -> job -> application).
 *
 * Only the external ATS website is mocked (the loopback mock ATS servers in
 * packages/greenhouse and packages/lever test fixtures). Everything else is
 * the production code path - nothing on the core path is stubbed.
 *
 * All fixture data is deterministic and synthetic (test.invalid emails,
 * 555-01xx phone numbers) - never real candidate data.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load .env BEFORE any @jaa/database import instantiates Prisma (repo
// convention). Heavy modules are imported lazily below so this always runs
// first.
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env'),
});
process.env.DATABASE_URL ??= 'postgresql://user:password@localhost:5432/jaa_dev';

// TEST-ONLY: run the E2E suites against their own Redis logical DB so a
// foreign consumer (e.g. a dev apps/worker running alongside) can never
// steal and fail the suites' jobs, and so the suites' queue resets never
// disturb a real development queue. Queue names stay the production ones;
// only the Redis namespace differs. Host/auth/port from REDIS_URL are
// preserved; an unparseable URL is left untouched (fall back to shared DB).
const testRedisDb = process.env.JAA_TEST_REDIS_DB ?? '15';
try {
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  redisUrl.pathname = `/${testRedisDb}`;
  process.env.REDIS_URL = redisUrl.toString();
} catch {
  // keep whatever REDIS_URL the environment provides
}

/**
 * TEST-ONLY (Phase 14): let the REAL registry bootstrap
 * (createPreparationRegistry in @jaa/core) recognize the loopback mock ATS
 * hosts so the full API -> queue -> worker path works against local mock
 * servers. Ignored when NODE_ENV=production. This only affects URL
 * RECOGNITION - it never relaxes the @jaa/browser SSRF policy
 * (`allowPrivateUrls` remains a separate, explicit, default-off opt-in).
 *
 * The hosts are scoped per provider because registry lookup is
 * first-match-wins: with one shared list the first registered adapter
 * (Greenhouse) would claim every mock URL, including Lever's. Each mock ATS
 * therefore lives on its own loopback address.
 */
process.env.JAA_TEST_EXTRA_BOARD_HOSTS_GREENHOUSE = '127.0.0.1';
process.env.JAA_TEST_EXTRA_BOARD_HOSTS_LEVER = '127.0.0.2';

/**
 * TEST-ONLY (Phase 15A): enable the MOCK submission boundary. Without this
 * explicit opt-in - and always in production - the submission policy
 * refuses every submission, so no code path can submit a real application.
 * Even with it enabled, only LOOPBACK mock ATS targets are accepted.
 */
process.env.JAA_ALLOW_MOCK_SUBMISSION = 'true';

/** Loopback address the mock Greenhouse server binds to. */
export const GREENHOUSE_BOARD_HOST = '127.0.0.1';
/** Loopback address the mock Lever server binds to. */
export const LEVER_BOARD_HOST = '127.0.0.2';

/**
 * Real infrastructure probes: the E2E suites need BOTH PostgreSQL and
 * Redis, so they skip (repo convention) when either is unreachable instead
 * of failing spuriously.
 */
export async function hasDatabase(): Promise<boolean> {
  try {
    const prisma = await getPrisma();
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function hasRedis(): Promise<boolean> {
  const { getPreparationQueue, closePreparationQueue } = await import('@jaa/core');
  try {
    await getPreparationQueue().getJobCounts('waiting');
    return true;
  } catch {
    return false;
  } finally {
    await closePreparationQueue().catch(() => undefined);
  }
}

export async function getPrisma() {
  const { prisma } = await import('@jaa/database');
  return prisma;
}

// ---------------------------------------------------------------------------
// Real API harness (the production Express router - not a mock)
// ---------------------------------------------------------------------------

export interface ApiServer {
  port: number;
  close(): Promise<void>;
}

export async function startApiServer(): Promise<ApiServer> {
  const express = (await import('express')).default;
  const { userMiddleware, errorHandler } = await import('../../src/middleware/auth');
  const { default: applicationsRouter } = await import('../../src/routes/applications');

  const app = express();
  app.use(express.json());
  app.use(userMiddleware);
  app.use('/api/applications', applicationsRouter);
  app.use(errorHandler);

  const server = await new Promise<{ close(cb?: (err?: Error) => void): void; address(): unknown }>(
    (resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s as never));
    }
  );
  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export function api(port: number) {
  return {
    get: (urlPath: string) => fetch(`http://127.0.0.1:${port}${urlPath}`),
    post: (urlPath: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

/**
 * The dev `userMiddleware` resolves the caller per request from
 * `process.env.USER_ID`. Tests impersonate the fixture's user by setting it
 * (the same convention as the existing API tests).
 */
export function authenticateAs(userId: string): void {
  process.env.USER_ID = userId;
}

// ---------------------------------------------------------------------------
// Database fixture chain: user -> candidate profile -> resume -> approved
// ResumeVersion -> job -> application (all synthetic data)
// ---------------------------------------------------------------------------

export interface ApplicationFixture {
  userId: string;
  jobId: string;
  resumeId: string;
  resumeVersionId: string;
  applicationId: string;
  /** Synthetic PII used to prove it never leaks into events/queues. */
  email: string;
  phone: string;
}

export async function createApplicationFixture(params: {
  prefix: string;
  ats: 'GREENHOUSE' | 'LEVER';
  applicationUrl: string;
}): Promise<ApplicationFixture> {
  const prisma = await getPrisma();
  const { prefix, ats, applicationUrl } = params;

  const userId = `${prefix}-user`;
  const email = `${prefix}@test.invalid`;
  const phone = '+1-555-0100';

  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, email, name: 'Phase 14 E2E Candidate' },
  });

  await prisma.candidateProfile.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      firstName: 'Phase14',
      lastName: 'Candidate',
      preferredName: 'P14',
      email,
      phone,
      location: 'Testville, TS',
      city: 'Testville',
      state: 'TS',
      country: 'US',
      zipCode: '00000',
      linkedinUrl: 'https://www.linkedin.com/in/phase14-test-candidate',
      githubUrl: 'https://github.com/phase14-test-candidate',
      portfolioUrl: 'https://phase14-test-candidate.test.invalid',
      workAuthorization: 'AUTHORIZED',
      sponsorshipRequired: false,
      willingToRelocate: false,
      desiredRoles: ['Software Engineer'],
      desiredSalaryMin: 1,
      desiredSalaryMax: 2,
      summary: 'Synthetic end-to-end test candidate. Not a real person.',
    },
  });

  const resume = await prisma.resume.create({
    data: {
      userId,
      name: `${prefix} resume`,
      originalFileName: `${prefix}-resume.txt`,
      fileType: 'pdf',
      storageKey: `test/${prefix}-resume.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
      isDefault: true,
    },
  });

  const sourceVersion = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: `test/${prefix}-resume-v1.txt`,
      source: 'ORIGINAL',
      extractedText: 'Synthetic test resume text. Not real candidate content.',
    },
  });

  const approvedVersion = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 2,
      filePath: `test/${prefix}-resume-v2.txt`,
      source: 'TAILORED',
      extractedText: 'Synthetic tailored resume text. Not real candidate content.',
      reviewStatus: 'APPROVED',
      reviewedAt: new Date(),
      reviewedBy: userId,
      tailoring: {
        sourceVersionId: sourceVersion.id,
        strategy: 'JOB_ALIGNED_V1',
        aiGenerated: true,
        provider: 'mock',
        validationStatus: 'PASSED',
        contentFormat: 'STRUCTURED_JSON',
        promptVersion: 'v1',
        generatedAt: '2026-10-05T00:00:00.000Z',
      } as object,
    },
  });

  const job = await prisma.job.create({
    data: {
      userId,
      source: ats,
      ats,
      url: `${applicationUrl}#job-${prefix}-${Date.now()}`,
      applicationUrl,
      company: 'Phase 14 TestCo',
      title: `${ats} E2E Role`,
      description: 'Deterministic end-to-end test job. Not a real posting.',
    },
  });

  const application = await prisma.application.create({
    data: {
      userId,
      jobId: job.id,
      resumeVersionId: approvedVersion.id,
      ats,
      applicationUrl,
      status: 'DISCOVERED',
    },
  });

  // Subsequent API requests act as this fixture's user.
  authenticateAs(userId);

  return {
    userId,
    jobId: job.id,
    resumeId: resume.id,
    resumeVersionId: approvedVersion.id,
    applicationId: application.id,
    email,
    phone,
  };
}

/** Remove everything created for a fixture prefix (cascades where defined). */
export async function cleanupFixture(fixture: ApplicationFixture): Promise<void> {
  const prisma = await getPrisma();
  await prisma.automationRun
    .deleteMany({ where: { applicationId: fixture.applicationId } })
    .catch(() => undefined);
  await prisma.applicationEvent
    .deleteMany({ where: { applicationId: fixture.applicationId } })
    .catch(() => undefined);
  await prisma.application
    .deleteMany({ where: { id: fixture.applicationId } })
    .catch(() => undefined);
  await prisma.resume.deleteMany({ where: { userId: fixture.userId } }).catch(() => undefined);
  await prisma.job.deleteMany({ where: { userId: fixture.userId } }).catch(() => undefined);
  await prisma.candidateProfile
    .deleteMany({ where: { userId: fixture.userId } })
    .catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: fixture.userId } }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Answer fixtures (synthetic, human-approved answers for required questions)
// ---------------------------------------------------------------------------

export interface AnswerFixtureOptions {
  /** Question IDs to leave unanswered (missing-answer scenarios). */
  skipQuestionIds?: string[];
  /** Question IDs whose answer awaits human review (needsReview, unapproved). */
  needsReviewQuestionIds?: string[];
}

/**
 * Provide a synthetic, human-approved answer for every required question of
 * a prepared application (the "answers reviewed and approved" fixture).
 * All values are synthetic (option values from the form, or a neutral
 * placeholder) - never real candidate data.
 */
export async function answerAllRequiredQuestions(
  applicationId: string,
  options: AnswerFixtureOptions = {}
): Promise<{ answeredQuestionIds: string[]; questionIds: string[] }> {
  const prisma = await getPrisma();
  const questions = await prisma.applicationQuestion.findMany({
    where: { applicationId, required: true },
  });
  const answeredQuestionIds: string[] = [];
  for (const question of questions) {
    if (options.skipQuestionIds?.includes(question.id)) continue;
    const optionList = (Array.isArray(question.options)
      ? (question.options as { value: string; label: string }[])
      : []
    ).filter((option) => (option.value ?? '').trim().length > 0);
    const answerText =
      question.fieldType === 'FILE'
        ? `test/synthetic-upload-${question.id}.txt`
        : optionList.length > 0
          ? optionList[0].value
          : `Synthetic answer ${question.id}`;
    const needsReview = options.needsReviewQuestionIds?.includes(question.id) ?? false;
    await prisma.applicationAnswer.create({
      data: {
        questionId: question.id,
        answer: answerText,
        source: 'USER_INPUT',
        confidence: 1,
        groundedFacts: [],
        needsReview,
        approved: !needsReview,
        generatedAt: new Date(),
      },
    });
    answeredQuestionIds.push(question.id);
  }
  return {
    answeredQuestionIds,
    questionIds: questions.map((question) => question.id),
  };
}

// ---------------------------------------------------------------------------
// Queue / worker helpers (real @jaa/core BullMQ wiring)
// ---------------------------------------------------------------------------

export interface JobLike {
  data: { applicationId?: string; automationRunId?: string };
  attemptsMade?: number;
}

/** All BullMQ jobs (any state) whose payload references the application. */
export async function jobsFor(applicationId: string): Promise<JobLike[]> {
  const { getPreparationQueue } = await import('@jaa/core');
  const queue = getPreparationQueue();
  const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  return jobs.filter(
    (j) => (j.data as { applicationId?: string })?.applicationId === applicationId
  ) as unknown as JobLike[];
}

/** Start the REAL preparation worker (same wiring as apps/worker). */
export async function startPreparationWorker(options?: {
  allowPrivateUrls?: boolean;
  concurrency?: number;
  staleMs?: number;
}) {
  const { createPreparationWorker } = await import('@jaa/core');
  const worker = createPreparationWorker({
    // Production queue name and production registry (the test-only
    // JAA_TEST_EXTRA_BOARD_HOSTS seam above adds the mock hosts).
    allowPrivateUrls: options?.allowPrivateUrls ?? true,
    concurrency: options?.concurrency ?? 1,
    ...(options?.staleMs ? { staleMs: options.staleMs } : {}),
  });
  // Surface job failures in the test output: a failed job leaves the run
  // FAILED and every waitFor(COMPLETED) would otherwise time out blind.
  worker.on('failed', (job, err) => {
    console.error(
      `[E2E-PREP-WORKER] job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err?.message}`
    );
  });
  return worker;
}

/** Drain and remove the shared test queue (test isolation). */
export async function resetPreparationQueue(): Promise<void> {
  const { getPreparationQueue, closePreparationQueue } = await import('@jaa/core');
  const queue = getPreparationQueue();
  await queue.drain(true).catch(() => undefined);
  await queue.obliterate({ force: true }).catch(() => undefined);
  await closePreparationQueue();
}

// ---------------------------------------------------------------------------
// Submission queue / worker helpers (Phase 15A, real @jaa/core wiring)
// ---------------------------------------------------------------------------

/** All BullMQ submission jobs (any state) whose payload references the application. */
export async function submissionJobsFor(applicationId: string): Promise<JobLike[]> {
  const { getSubmissionQueue } = await import('@jaa/core');
  const queue = getSubmissionQueue();
  const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  return jobs.filter(
    (j) => (j.data as { applicationId?: string })?.applicationId === applicationId
  ) as unknown as JobLike[];
}

/** Start the REAL submission worker (same wiring as apps/worker). */
export async function startSubmissionWorker(options?: {
  allowPrivateUrls?: boolean;
  concurrency?: number;
  staleMs?: number;
  /** Test seam: wraps/replaces the core submitApplication (e.g. crash simulation). */
  submit?: import('@jaa/core').SubmissionJobFn;
}) {
  const { createSubmissionWorker } = await import('@jaa/core');
  const worker = createSubmissionWorker({
    // Production queue name and production registry (the test-only
    // JAA_TEST_EXTRA_BOARD_HOSTS seam adds the mock hosts).
    allowPrivateUrls: options?.allowPrivateUrls ?? true,
    concurrency: options?.concurrency ?? 1,
    ...(options?.staleMs ? { staleMs: options.staleMs } : {}),
    ...(options?.submit ? { submit: options.submit } : {}),
  });
  // Surface job failures in the test output (see startPreparationWorker).
  worker.on('failed', (job, err) => {
    console.error(
      `[E2E-SUB-WORKER] job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err?.message}`
    );
  });
  return worker;
}

/** Drain and remove the shared submission test queue (test isolation). */
export async function resetSubmissionQueue(): Promise<void> {
  const { getSubmissionQueue, closeSubmissionQueue } = await import('@jaa/core');
  const queue = getSubmissionQueue();
  await queue.drain(true).catch(() => undefined);
  await queue.obliterate({ force: true }).catch(() => undefined);
  await closeSubmissionQueue();
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined>,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
    /** Extra state for the timeout error (e.g. the run row's error fields). */
    describe?: () => Promise<string | undefined> | string | undefined;
  } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) {
      const detail = opts.describe ? await opts.describe().catch(() => undefined) : undefined;
      throw new Error(
        `waitFor timed out${opts.label ? `: ${opts.label}` : ''}${detail ? ` (${detail})` : ''}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Poll until the AutomationRun for the application satisfies `done`.
 *
 * Note: a run may transiently sit in FAILED while a retryable job error is
 * retried (the handler re-claims FAILED runs), so a FAILED snapshot is not
 * by itself terminal - the timeout error surfaces the run's status,
 * errorCode and errorMessage so a real failure is diagnosable immediately.
 */
export async function waitForRun(
  applicationId: string,
  done: (run: { status: string }) => boolean,
  opts: { timeoutMs?: number; label?: string } = {}
) {
  const prisma = await getPrisma();
  return waitFor(
    async () => {
      const run = await prisma.automationRun.findUnique({ where: { applicationId } });
      return run && done(run) ? run : null;
    },
    {
      timeoutMs: opts.timeoutMs ?? 90_000,
      label: opts.label ?? 'automation run',
      describe: async () => {
        const run = await prisma.automationRun.findUnique({ where: { applicationId } });
        if (!run) return 'run row missing';
        const errorCode = (run.metadata as { errorCode?: string } | null)?.errorCode;
        return `run status=${run.status}${errorCode ? ` errorCode=${errorCode}` : ''}${
          run.errorMessage ? ` errorMessage=${run.errorMessage}` : ''
        }`;
      },
    }
  );
}

/** Poll until the application status satisfies `done`. */
export async function waitForApplication(
  applicationId: string,
  done: (app: { status: string }) => boolean,
  opts: { timeoutMs?: number; label?: string } = {}
) {
  const prisma = await getPrisma();
  return waitFor(
    async () => {
      const app = await prisma.application.findUnique({ where: { id: applicationId } });
      return app && done(app) ? app : null;
    },
    { timeoutMs: opts.timeoutMs ?? 90_000, label: opts.label ?? 'application' }
  );
}

/**
 * Best-effort browser cleanup between suites. Public @jaa/browser API only -
 * no Playwright imports ever leave packages/browser. Cleanup only; the E2E
 * path itself never touches this module.
 */
export async function closeBrowserQuietly(): Promise<void> {
  try {
    const { closeBrowser } = await import('@jaa/browser');
    await closeBrowser();
  } catch {
    // Cleanup is best effort.
  }
}
