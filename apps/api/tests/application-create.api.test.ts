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
const { getSubmissionQueue, closeSubmissionQueue } = await import('@jaa/core');
const express = (await import('express')).default;
const { default: applicationsRouter } = await import('../src/routes/applications');
const { default: jobsRouter } = await import('../src/routes/jobs');
const { userMiddleware, errorHandler } = await import('../src/middleware/auth');

const TEST_USER_ID = 'apply-api-user';
const INTRUDER_ID = 'apply-api-intruder';
// Isolated users for tests whose assertions depend on which resume versions
// exist for the acting user (default resolution, "no approved resume").
const DEFAULT_USER_ID = 'apply-api-default-user';
const NORESUME_USER_ID = 'apply-api-noresume-user';
const ALL_USER_IDS = [TEST_USER_ID, INTRUDER_ID, DEFAULT_USER_ID, NORESUME_USER_ID];

const submissionQueue = getSubmissionQueue();
const HAS_REDIS = await submissionQueue
  .getJobCounts('waiting')
  .then(() => true)
  .catch(() => false);

let authenticatedPort: number;
let barePort: number;
let servers: Array<{ close: () => void }> = [];
let counter = 0;

function buildApp(withAuth: boolean) {
  const app = express();
  app.use(express.json());
  if (withAuth) app.use(userMiddleware);
  app.use('/api/applications', applicationsRouter);
  app.use('/api/jobs', jobsRouter);
  app.use(errorHandler);
  return app;
}

async function listen(app: ReturnType<typeof buildApp>): Promise<number> {
  const server = await new Promise<{ close: () => void; address: () => unknown }>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s as never));
  });
  servers.push(server);
  return (server.address() as { port: number }).port;
}

function api(port: number) {
  return {
    get: (urlPath: string) => fetch(`http://127.0.0.1:${port}${urlPath}`),
    post: (urlPath: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    delete: (urlPath: string) =>
      fetch(`http://127.0.0.1:${port}${urlPath}`, { method: 'DELETE' }),
  };
}

/** Act as the given user for subsequent API requests and fixtures. */
async function switchUser(userId: string): Promise<void> {
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, email: `${userId}@test.local`, name: 'Apply API User' },
  });
  process.env.USER_ID = userId;
}

/** A job the acting user owns. `applicationUrl` controls board support for Apply. */
async function makeJob(opts: { applicationUrl?: string; userId?: string } = {}) {
  counter += 1;
  return prisma.job.create({
    data: {
      userId: opts.userId ?? process.env.USER_ID ?? TEST_USER_ID,
      source: 'GREENHOUSE',
      ats: 'GREENHOUSE',
      url: `https://example.com/apply-api-job-${Date.now()}-${counter}`,
      applicationUrl:
        opts.applicationUrl === undefined
          ? `https://job-boards.greenhouse.io/testco/jobs/${Date.now()}-${counter}`
          : opts.applicationUrl,
      company: 'Apply API TestCo',
      title: `Apply API Role ${counter}`,
    },
  });
}

/** A resume (with one version) the user owns. */
async function makeResume(opts: {
  reviewStatus?: 'PENDING' | 'APPROVED' | 'REJECTED';
  isDefault?: boolean;
  userId?: string;
} = {}) {
  counter += 1;
  const userId = opts.userId ?? process.env.USER_ID ?? TEST_USER_ID;
  const resume = await prisma.resume.create({
    data: {
      userId,
      name: `Apply API resume ${counter}`,
      originalFileName: `apply-api-${counter}.txt`,
      fileType: 'pdf',
      storageKey: `test/apply-api-${counter}.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
      isDefault: opts.isDefault ?? false,
    },
  });
  const version = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: `test/apply-api-${counter}-v1.txt`,
      source: 'ORIGINAL',
      reviewStatus: opts.reviewStatus ?? 'PENDING',
    },
  });
  return { resume, version };
}

describe.skipIf(!HAS_DB || !HAS_REDIS)('POST /api/applications (the Apply action)', () => {
  beforeAll(async () => {
    for (const [id, email] of [
      [TEST_USER_ID, 'apply-api-user@test.local'],
      [INTRUDER_ID, 'apply-api-intruder@test.local'],
    ] as const) {
      await prisma.user.upsert({
        where: { id },
        update: {},
        create: { id, email, name: 'Apply API User' },
      });
    }
    authenticatedPort = await listen(buildApp(true));
    barePort = await listen(buildApp(false));
    process.env.USER_ID = TEST_USER_ID;
  });

  afterAll(async () => {
    delete process.env.USER_ID;
    for (const s of servers) s.close();
    servers = [];
    await submissionQueue.drain(true).catch(() => undefined);
    await submissionQueue.obliterate({ force: true }).catch(() => undefined);
    await closeSubmissionQueue();

    await prisma.automationRun.deleteMany({ where: { userId: { in: ALL_USER_IDS } } });
    await prisma.applicationEvent.deleteMany({ where: { userId: { in: ALL_USER_IDS } } });
    await prisma.application.deleteMany({ where: { userId: { in: ALL_USER_IDS } } });
    await prisma.resume.deleteMany({ where: { userId: { in: ALL_USER_IDS } } });
    await prisma.job.deleteMany({ where: { userId: { in: ALL_USER_IDS } } });
    await prisma.user.deleteMany({ where: { id: { in: ALL_USER_IDS } } });
    await prisma.$disconnect();
  });

  it('creates an application for an eligible job and never claims submission', async () => {
    const job = await makeJob();
    const { version } = await makeResume({ reviewStatus: 'APPROVED', isDefault: true });

    const res = await api(authenticatedPort).post('/api/applications', {
      jobId: job.id,
      resumeVersionId: version.id,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.alreadyExists).toBe(false);
    expect(body.data.jobId).toBe(job.id);
    expect(body.data.status).toBe('DISCOVERED');
    expect(body.data.resumeVersionId).toBe(version.id);
    expect(body.data.applicationUrl).toBe(job.applicationUrl);
    // Honest status: a fresh application is never presented as submitted and
    // carries no provider evidence.
    expect(body.data.submittedAt).toBeNull();
    expect(body.data.externalApplicationId).toBeNull();
    expect(body.data.submissionStatus.phase).toBe('PREPARATION_REQUIRED');

    // Persisted record matches the response.
    const row = await prisma.application.findUnique({
      where: { id: body.data.id },
      include: { events: true },
    });
    expect(row?.userId).toBe(TEST_USER_ID);
    expect(row?.ats).toBe('GREENHOUSE');
    expect(row?.events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['APPLICATION_CREATED', 'RESUME_SELECTED'])
    );

    // Creating an application NEVER queues anything and NEVER starts a
    // submission: no automation run, no submission jobs, no ledger events.
    expect(
      await prisma.automationRun.findUnique({ where: { applicationId: body.data.id } })
    ).toBeNull();
    const queueJobs = await submissionQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    expect(
      queueJobs.filter((j) => (j.data as { applicationId?: string })?.applicationId === body.data.id)
    ).toHaveLength(0);
  });

  it('resolves the default approved resume version when none is specified', async () => {
    await switchUser(DEFAULT_USER_ID);
    const job = await makeJob();
    await makeResume({ reviewStatus: 'PENDING' });
    const { version: approved } = await makeResume({ reviewStatus: 'APPROVED', isDefault: true });

    const res = await api(authenticatedPort).post('/api/applications', { jobId: job.id });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.resumeVersionId).toBe(approved.id);
    await switchUser(TEST_USER_ID);
  });

  it('a duplicate Apply click returns the same application (exactly one row)', async () => {
    const job = await makeJob();
    const { version } = await makeResume({ reviewStatus: 'APPROVED', isDefault: true });

    const first = await api(authenticatedPort).post('/api/applications', {
      jobId: job.id,
      resumeVersionId: version.id,
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const second = await api(authenticatedPort).post('/api/applications', {
      jobId: job.id,
      resumeVersionId: version.id,
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.alreadyExists).toBe(true);
    expect(secondBody.data.id).toBe(firstBody.data.id);

    const rows = await prisma.application.findMany({ where: { jobId: job.id } });
    expect(rows).toHaveLength(1);
  });

  it('refuses without an approved resume and creates nothing', async () => {
    await switchUser(NORESUME_USER_ID);
    const job = await makeJob();
    await makeResume({ reviewStatus: 'PENDING', isDefault: true });

    const res = await api(authenticatedPort).post('/api/applications', { jobId: job.id });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('RESUME_NOT_APPROVED');
    expect(await prisma.application.count({ where: { jobId: job.id } })).toBe(0);
    await switchUser(TEST_USER_ID);
  });

  it('refuses an unapproved or foreign resume version and creates nothing', async () => {
    const job = await makeJob();
    const { version: pending } = await makeResume({ reviewStatus: 'PENDING' });
    const res = await api(authenticatedPort).post('/api/applications', {
      jobId: job.id,
      resumeVersionId: pending.id,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('RESUME_NOT_APPROVED');

    const { version: foreign } = await makeResume({
      reviewStatus: 'APPROVED',
      userId: INTRUDER_ID,
    });
    const foreignRes = await api(authenticatedPort).post('/api/applications', {
      jobId: job.id,
      resumeVersionId: foreign.id,
    });
    expect(foreignRes.status).toBe(404);
    expect((await foreignRes.json()).error.code).toBe('NOT_FOUND');

    expect(await prisma.application.count({ where: { jobId: job.id } })).toBe(0);
  });

  it('refuses an unsupported board before creating anything', async () => {
    const job = await makeJob({ applicationUrl: 'https://example.com/apply-now' });
    const { version } = await makeResume({ reviewStatus: 'APPROVED', isDefault: true });

    const res = await api(authenticatedPort).post('/api/applications', {
      jobId: job.id,
      resumeVersionId: version.id,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('UNSUPPORTED_ATS');
    expect(await prisma.application.count({ where: { jobId: job.id } })).toBe(0);
  });

  it('refuses invalid or non-http application URLs before creating anything', async () => {
    const { version } = await makeResume({ reviewStatus: 'APPROVED', isDefault: true });

    for (const applicationUrl of ['not-a-url', 'javascript:alert(1)']) {
      const job = await makeJob({ applicationUrl });
      const res = await api(authenticatedPort).post('/api/applications', {
        jobId: job.id,
        resumeVersionId: version.id,
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe('INVALID_APPLICATION_URL');
      expect(await prisma.application.count({ where: { jobId: job.id } })).toBe(0);
    }
  });

  it('404s for missing and foreign jobs without leaking existence', async () => {
    const missing = await api(authenticatedPort).post('/api/applications', {
      jobId: 'nope',
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('NOT_FOUND');

    const foreignJob = await makeJob({ userId: INTRUDER_ID });
    const foreign = await api(authenticatedPort).post('/api/applications', {
      jobId: foreignJob.id,
    });
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.code).toBe('NOT_FOUND');
  });

  it('400s on invalid bodies and 401s without authentication', async () => {
    for (const body of [{}, { jobId: '' }, { jobId: 42 }, { jobId: 'x', resumeVersionId: 7 }]) {
      const res = await api(authenticatedPort).post('/api/applications', body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    }

    const job = await makeJob();
    const bare = await api(barePort).post('/api/applications', { jobId: job.id });
    expect(bare.status).toBe(401);
    expect(await prisma.application.count({ where: { jobId: job.id } })).toBe(0);
  });

  it('restores the same honest status from the API after a refresh (GET)', async () => {
    const job = await makeJob();
    const { version } = await makeResume({ reviewStatus: 'APPROVED', isDefault: true });
    const created = await (
      await api(authenticatedPort).post('/api/applications', {
        jobId: job.id,
        resumeVersionId: version.id,
      })
    ).json();

    const detail = await api(authenticatedPort).get(`/api/applications/${created.data.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.data.id).toBe(created.data.id);
    expect(detailBody.data.submissionStatus.phase).toBe('PREPARATION_REQUIRED');
    expect(Array.isArray(detailBody.data.questions)).toBe(true);
    expect(Array.isArray(detailBody.data.events)).toBe(true);

    const list = await api(authenticatedPort).get('/api/applications');
    const listBody = await list.json();
    const listed = listBody.data.find((a: { id: string }) => a.id === created.data.id);
    expect(listed.jobId).toBe(job.id);
    expect(listed.submissionStatus.phase).toBe('PREPARATION_REQUIRED');
  });

  it('jobs list carries applySupported and DELETE removes only own jobs', async () => {
    const supportedJob = await makeJob();
    const unsupportedJob = await makeJob({ applicationUrl: 'https://example.com/apply' });

    const list = await api(authenticatedPort).get('/api/jobs?page=1&pageSize=100');
    expect(list.status).toBe(200);
    const jobs: Array<{ id: string; applySupported: boolean }> = (await list.json()).data;
    expect(jobs.find((j) => j.id === supportedJob.id)?.applySupported).toBe(true);
    expect(jobs.find((j) => j.id === unsupportedJob.id)?.applySupported).toBe(false);

    // The old UI deleted via a relative URL and ALWAYS showed success while
    // nothing was deleted. The API must really delete - and refuse foreign jobs.
    const foreignJob = await makeJob({ userId: INTRUDER_ID });
    const foreignDelete = await api(authenticatedPort).delete(`/api/jobs/${foreignJob.id}`);
    expect(foreignDelete.status).toBe(404);
    expect(await prisma.job.findUnique({ where: { id: foreignJob.id } })).not.toBeNull();

    const deleteRes = await api(authenticatedPort).delete(`/api/jobs/${supportedJob.id}`);
    expect(deleteRes.status).toBe(200);
    expect(await prisma.job.findUnique({ where: { id: supportedJob.id } })).toBeNull();
  });
});
