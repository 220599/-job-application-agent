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
const { getPreparationQueue, closePreparationQueue, PREPARATION_QUEUE_NAME } = await import(
  '@jaa/core'
);
const express = (await import('express')).default;
const { default: applicationsRouter } = await import('../src/routes/applications');
const { userMiddleware, errorHandler } = await import('../src/middleware/auth');

const TEST_USER_ID = 'orchestr-api-user';
const INTRUDER_ID = 'orchestr-api-intruder';

// Redis availability (existing Docker Redis - no second service).
const queue = getPreparationQueue();
const HAS_REDIS = await queue
  .getJobCounts('waiting')
  .then(() => true)
  .catch(() => false);

let authenticatedPort: number;
let barePort: number;
let servers: Array<{ close: () => void }> = [];
let jobId: string;
let counter = 0;

function buildApp(withAuth: boolean) {
  const app = express();
  app.use(express.json());
  if (withAuth) app.use(userMiddleware);
  app.use('/api/applications', applicationsRouter);
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
  };
}

interface MakeAppOptions {
  reviewStatus?: 'PENDING' | 'APPROVED';
  applicationUrl?: string | null;
  status?: string;
}

async function makeApplication(opts: MakeAppOptions = {}) {
  counter += 1;
  const resume = await prisma.resume.create({
    data: {
      userId: TEST_USER_ID,
      name: `Orchestr API resume ${counter}`,
      originalFileName: `orchestr-api-${counter}.txt`,
      fileType: 'pdf',
      storageKey: `test/orchestr-api-${counter}.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
    },
  });
  const source = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: `test/orchestr-api-${counter}-v1.txt`,
      source: 'ORIGINAL',
    },
  });
  const version = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 2,
      filePath: `test/orchestr-api-${counter}-v2.txt`,
      source: 'TAILORED',
      reviewStatus: opts.reviewStatus ?? 'PENDING',
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
  return application;
}

/** Jobs in the queue whose payload references the given application. */
async function jobsFor(applicationId: string) {
  const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  return jobs.filter((j) => (j.data as { applicationId?: string })?.applicationId === applicationId);
}

describe.skipIf(!HAS_DB || !HAS_REDIS)('application orchestration API', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: 'orchestr-api-user@test.local', name: 'Orchestr API User' },
    });
    await prisma.user.upsert({
      where: { id: INTRUDER_ID },
      update: {},
      create: { id: INTRUDER_ID, email: 'orchestr-api-intruder@test.local', name: 'Intruder' },
    });
    const job = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'GREENHOUSE',
        url: `https://example.com/orchestr-api-job-${Date.now()}`,
        company: 'Orchestr API Co',
        title: 'Orchestr API Role',
      },
    });
    jobId = job.id;

    authenticatedPort = await listen(buildApp(true));
    barePort = await listen(buildApp(false));

    process.env.USER_ID = TEST_USER_ID;
  });

  afterAll(async () => {
    delete process.env.USER_ID;
    for (const s of servers) s.close();
    servers = [];
    // Leave no jobs behind in the shared Redis queue.
    await queue.drain(true).catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await closePreparationQueue();

    await prisma.automationRun.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.applicationEvent.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.application.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.resume.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.job.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.user.deleteMany({ where: { id: { in: [TEST_USER_ID, INTRUDER_ID] } } });
    await prisma.$disconnect();
  });

  it('requires authentication on every orchestration endpoint (401)', async () => {
    const application = await makeApplication({ reviewStatus: 'APPROVED' });

    for (const res of [
      await api(barePort).post(`/api/applications/${application.id}/prepare`),
      await api(barePort).get(`/api/applications/${application.id}/automation`),
      await api(barePort).post(`/api/applications/${application.id}/automation/cancel`),
    ]) {
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('UNAUTHORIZED');
    }
    expect(await prisma.automationRun.findUnique({ where: { applicationId: application.id } })).toBeNull();
  });

  it('returns 404 for missing and foreign applications (no existence leak)', async () => {
    const missing = await api(authenticatedPort).post('/api/applications/nope/prepare');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('APPLICATION_NOT_FOUND');

    const application = await makeApplication({ reviewStatus: 'APPROVED' });
    process.env.USER_ID = INTRUDER_ID;
    for (const res of [
      await api(authenticatedPort).post(`/api/applications/${application.id}/prepare`),
      await api(authenticatedPort).get(`/api/applications/${application.id}/automation`),
      await api(authenticatedPort).post(`/api/applications/${application.id}/automation/cancel`),
    ]) {
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('APPLICATION_NOT_FOUND');
    }
    process.env.USER_ID = TEST_USER_ID;
    expect(await prisma.automationRun.findUnique({ where: { applicationId: application.id } })).toBeNull();
  });

  it('refuses applications without an approved resume (422) and unsupported ATS (422)', async () => {
    const pending = await makeApplication({ reviewStatus: 'PENDING' });
    const res = await api(authenticatedPort).post(`/api/applications/${pending.id}/prepare`);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('RESUME_NOT_APPROVED');

    const unsupported = await makeApplication({
      reviewStatus: 'APPROVED',
      applicationUrl: 'https://careers.unknown-ats.example/apply/42',
    });
    const res2 = await api(authenticatedPort).post(`/api/applications/${unsupported.id}/prepare`);
    expect(res2.status).toBe(422);
    expect((await res2.json()).error.code).toBe('UNSUPPORTED_ATS');
  });

  it('queues a valid application and returns the AutomationRun (202)', async () => {
    const application = await makeApplication({ reviewStatus: 'APPROVED' });
    const res = await api(authenticatedPort).post(`/api/applications/${application.id}/prepare`);
    expect(res.status).toBe(202);
    const body = await res.json();

    expect(body.automationRun).toMatchObject({
      applicationId: application.id,
      status: 'QUEUED',
      provider: 'GREENHOUSE',
    });
    expect(Object.keys(body.automationRun).sort()).toEqual([
      'applicationId',
      'completedAt',
      'createdAt',
      'errorCode',
      'errorMessage',
      'id',
      'provider',
      'startedAt',
      'status',
      'updatedAt',
    ]);

    // The real BullMQ payload contains IDENTIFIERS ONLY (security contract).
    const jobs = await jobsFor(application.id);
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0].data as object).sort()).toEqual(['applicationId', 'automationRunId']);
    expect(JSON.stringify(jobs[0].data)).not.toMatch(/resume|answer|fact|token|password/i);

    // Queueing never advances the application beyond DISCOVERED.
    const fresh = await prisma.application.findUnique({ where: { id: application.id } });
    expect(fresh!.status).toBe('DISCOVERED');
  });

  it('repeated prepare requests are idempotent (same run, one job)', async () => {
    const application = await makeApplication({ reviewStatus: 'APPROVED' });
    const first = await api(authenticatedPort).post(`/api/applications/${application.id}/prepare`);
    const second = await api(authenticatedPort).post(`/api/applications/${application.id}/prepare`);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const a = (await first.json()).automationRun;
    const b = (await second.json()).automationRun;
    expect(b.id).toBe(a.id);
    expect(b.status).toBe('QUEUED');
    expect(await jobsFor(application.id)).toHaveLength(1);
    expect(await prisma.automationRun.count({ where: { applicationId: application.id } })).toBe(1);
  });

  it('concurrent prepare requests never create duplicate active runs or jobs', async () => {
    const application = await makeApplication({ reviewStatus: 'APPROVED' });
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        api(authenticatedPort).post(`/api/applications/${application.id}/prepare`)
      )
    );
    for (const res of responses) expect(res.status).toBe(202);
    const ids = new Set(
      await Promise.all(responses.map(async (r) => (await r.json()).automationRun.id))
    );
    expect(ids.size).toBe(1);
    expect(await jobsFor(application.id)).toHaveLength(1);
    expect(await prisma.automationRun.count({ where: { applicationId: application.id } })).toBe(1);
  });

  it('exposes safe automation status only (no metadata, no Redis/worker internals)', async () => {
    const application = await makeApplication({ reviewStatus: 'APPROVED' });

    const empty = await api(authenticatedPort).get(`/api/applications/${application.id}/automation`);
    expect(empty.status).toBe(200);
    expect((await empty.json()).automationRun).toBeNull();

    await api(authenticatedPort).post(`/api/applications/${application.id}/prepare`);
    const res = await api(authenticatedPort).get(`/api/applications/${application.id}/automation`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.automationRun).toMatchObject({ applicationId: application.id, status: 'QUEUED' });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('metadata');
    expect(serialized).not.toContain('bullmq');
    expect(serialized).not.toContain('redis');
  });

  it('cancellation is safe and idempotent, and a cancelled run is never processed', async () => {
    const application = await makeApplication({ reviewStatus: 'APPROVED' });
    await api(authenticatedPort).post(`/api/applications/${application.id}/prepare`);

    const cancel = await api(authenticatedPort).post(
      `/api/applications/${application.id}/automation/cancel`
    );
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).automationRun.status).toBe('CANCELLED');

    // Idempotent repeat.
    const repeat = await api(authenticatedPort).post(
      `/api/applications/${application.id}/automation/cancel`
    );
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).automationRun.status).toBe('CANCELLED');

    const status = await api(authenticatedPort).get(`/api/applications/${application.id}/automation`);
    expect((await status.json()).automationRun.status).toBe('CANCELLED');
  });

  it('returns safe structured errors without stack traces or internals', async () => {
    const application = await makeApplication({ reviewStatus: 'APPROVED' });
    await prisma.automationRun.create({
      data: {
        userId: TEST_USER_ID,
        applicationId: application.id,
        provider: 'PLAYWRIGHT',
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });
    const res = await api(authenticatedPort).post(
      `/api/applications/${application.id}/automation/cancel`
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('AUTOMATION_NOT_CANCELLABLE');
    expect(body.error.message).not.toContain('prisma');
    expect(JSON.stringify(body)).not.toContain('stack');
  });
});
