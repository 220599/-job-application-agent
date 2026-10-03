import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Load DATABASE_URL before @jaa/database instantiates Prisma.
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/jaa_dev';

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { prisma } = await import('@jaa/database');
const { createMockAiProvider, setDefaultAiProvider } = await import('@jaa/ai');
const express = (await import('express')).default;
const { default: resumesRouter } = await import('../src/routes/resumes');
const { userMiddleware, errorHandler } = await import('../src/middleware/auth');

const TEST_USER_ID = 'tailor-api-user';
const INTRUDER_ID = 'tailor-api-intruder';

const SOURCE_TEXT =
  'Alice Nguyen. Senior Engineer at Acme Corp. Built data pipelines with SQL and Python. Reduced report time by 50%.';
const SOURCE_PARSED = {
  summary: 'Senior engineer focused on distributed systems.',
  skills: ['TypeScript', 'SQL', 'Python'],
  experience: [
    {
      company: 'Acme Corp',
      title: 'Senior Engineer',
      startDate: '2019-01',
      endDate: null,
      isCurrent: true,
      description: 'Built data pipelines with SQL and Python. Reduced report time by 50%.',
    },
  ],
  education: [
    { institution: 'State University', degree: 'Bachelor of Science', fieldOfStudy: 'Computer Science' },
  ],
};

const VALID_JSON = JSON.stringify({
  summary: 'Senior engineer focused on distributed systems, specializing in SQL and Python.',
  skills: ['SQL', 'Python', 'TypeScript'],
  experience: [
    {
      company: 'Acme Corp',
      title: 'Senior Engineer',
      bullets: ['Built data pipelines with SQL and Python', 'Reduced report time by 50%'],
    },
  ],
});

const FABRICATED_JSON = JSON.stringify({
  skills: ['TypeScript', 'Kubernetes'],
});

let authenticatedPort: number;
let barePort: number;
let servers: Array<{ close: () => void }> = [];
let jobId: string;
let intruderJobId: string;

function buildApp(withAuth: boolean) {
  const app = express();
  app.use(express.json());
  if (withAuth) app.use(userMiddleware);
  app.use('/api/resumes', resumesRouter);
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
    post: (urlPath: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

let resumeCounter = 0;
async function makeResume(label: string) {
  resumeCounter += 1;
  const resume = await prisma.resume.create({
    data: {
      userId: TEST_USER_ID,
      name: `Tailor API resume ${label} ${resumeCounter}`,
      originalFileName: `${label}.txt`,
      fileType: 'pdf',
      storageKey: `test/tailor-api-${label}-${resumeCounter}.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
    },
  });
  const version = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: `test/tailor-api-${label}-${resumeCounter}.txt`,
      source: 'ORIGINAL',
      extractedText: SOURCE_TEXT,
      parsedData: SOURCE_PARSED as object,
    },
  });
  return { resume, version };
}

describe.skipIf(!HAS_DB)('resume tailoring API', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: 'tailor-api-user@test.local', name: 'Tailor API User' },
    });
    await prisma.user.upsert({
      where: { id: INTRUDER_ID },
      update: {},
      create: { id: INTRUDER_ID, email: 'tailor-api-intruder@test.local', name: 'Intruder' },
    });

    const existing = await prisma.candidateProfile.findUnique({ where: { userId: TEST_USER_ID } });
    if (!existing) {
      const profile = await prisma.candidateProfile.create({
        data: {
          userId: TEST_USER_ID,
          firstName: 'Alice',
          lastName: 'Nguyen',
          email: 'alice@example.com',
          location: 'San Francisco, CA',
          summary: 'Senior engineer focused on distributed systems.',
        },
      });
      await prisma.experience.create({
        data: {
          candidateProfileId: profile.id,
          title: 'Senior Engineer',
          company: 'Acme Corp',
          employmentType: 'FULL_TIME',
          startDate: new Date('2019-01-01'),
          isCurrent: true,
          description: 'Built data pipelines with SQL and Python. Reduced report time by 50%.',
        },
      });
      await prisma.education.create({
        data: {
          candidateProfileId: profile.id,
          institution: 'State University',
          degree: 'Bachelor of Science',
          fieldOfStudy: 'Computer Science',
          startDate: new Date('2012-09-01'),
          endDate: new Date('2016-06-01'),
        },
      });
      for (const name of ['TypeScript', 'SQL', 'Python']) {
        await prisma.skill.create({ data: { candidateProfileId: profile.id, name } });
      }
    }

    const job = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'MOCK',
        url: `https://example.com/tailor-api-job-${Date.now()}`,
        company: 'InnovateCo',
        title: 'Staff Engineer',
        description: 'Build data platforms with SQL.',
      },
    });
    jobId = job.id;

    const intruderJob = await prisma.job.create({
      data: {
        userId: INTRUDER_ID,
        source: 'MOCK',
        url: `https://example.com/tailor-api-intruder-job-${Date.now()}`,
        company: 'SecretCo',
        title: 'Secret Role',
      },
    });
    intruderJobId = intruderJob.id;

    authenticatedPort = await listen(buildApp(true));
    barePort = await listen(buildApp(false));

    // Route-level tests drive the real default provider registry.
    process.env.USER_ID = TEST_USER_ID;
  });

  afterAll(async () => {
    setDefaultAiProvider(null);
    delete process.env.USER_ID;
    for (const s of servers) s.close();
    servers = [];
    // Remove tailored artifacts the API wrote via the default local store so
    // the test run leaves no filesystem side effects in the working tree.
    const fs = await import('fs/promises');
    const dir = path.join(process.cwd(), 'uploads', 'resumes');
    try {
      for (const file of await fs.readdir(dir)) {
        if (file.startsWith('tailor-api-user-') && file.endsWith('-tailored.json')) {
          await fs.rm(path.join(dir, file), { force: true });
        }
      }
    } catch {
      // Directory may not exist when all tests were skipped.
    }
  });

  it('requires authentication (no auth context -> 401, no version)', async () => {
    const { resume, version } = await makeResume('no-auth');
    const res = await api(barePort).post(`/api/resumes/${resume.id}/versions/${version.id}/tailor`, {
      jobId,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
    expect(await prisma.resumeVersion.count({ where: { resumeId: resume.id } })).toBe(1);
  });

  it('rejects invalid request bodies with VALIDATION_ERROR', async () => {
    const { resume, version } = await makeResume('bad-body');
    const missing = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${version.id}/tailor`,
      {}
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('VALIDATION_ERROR');

    const wrongType = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${version.id}/tailor`,
      { jobId: 42 }
    );
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()).error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.resumeVersion.count({ where: { resumeId: resume.id } })).toBe(1);
  });

  it('returns 404 (never leaks existence) for inaccessible resources', async () => {
    const { resume, version } = await makeResume('ownership');

    // Another user's resume.
    process.env.USER_ID = INTRUDER_ID;
    const foreignResume = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${version.id}/tailor`,
      { jobId: intruderJobId }
    );
    expect(foreignResume.status).toBe(404);
    expect((await foreignResume.json()).error.code).toBe('RESUME_NOT_FOUND');

    // Another user's job.
    process.env.USER_ID = TEST_USER_ID;
    const foreignJob = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${version.id}/tailor`,
      { jobId: intruderJobId }
    );
    expect(foreignJob.status).toBe(404);
    expect((await foreignJob.json()).error.code).toBe('JOB_NOT_FOUND');

    // A version that does not belong to the resume.
    const other = await makeResume('ownership-other');
    const foreignVersion = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${other.version.id}/tailor`,
      { jobId }
    );
    expect(foreignVersion.status).toBe(404);
    expect((await foreignVersion.json()).error.code).toBe('VERSION_NOT_FOUND');

    expect(await prisma.resumeVersion.count({ where: { resumeId: resume.id } })).toBe(1);
  });

  it('tailors successfully and exposes version history', async () => {
    const { resume, version } = await makeResume('success');
    setDefaultAiProvider(createMockAiProvider({ defaultText: VALID_JSON }));

    const res = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${version.id}/tailor`,
      { jobId }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.reused).toBe(false);
    expect(body.data.version.source).toBe('TAILORED');
    expect(body.data.version.versionNumber).toBe(2);
    expect(body.data.validation.valid).toBe(true);
    expect(body.data.provenance.aiGenerated).toBe(true);
    expect(body.data.content.skills).toEqual(['SQL', 'Python', 'TypeScript']);

    // Idempotent repeat returns the existing version (200, reused).
    const repeat = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${version.id}/tailor`,
      { jobId }
    );
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).data.reused).toBe(true);

    // Version list + get.
    const list = await api(authenticatedPort).get(`/api/resumes/${resume.id}/versions`);
    expect(list.status).toBe(200);
    const versions = (await list.json()).data;
    expect(versions.length).toBe(2);
    expect(versions.map((v: { source: string }) => v.source).sort()).toEqual(['ORIGINAL', 'TAILORED']);

    const single = await api(authenticatedPort).get(
      `/api/resumes/${resume.id}/versions/${version.id}`
    );
    expect(single.status).toBe(200);
    expect((await single.json()).data.id).toBe(version.id);

    const missing = await api(authenticatedPort).get(`/api/resumes/${resume.id}/versions/nope`);
    expect(missing.status).toBe(404);
  });

  it('returns a structured AI failure and creates no version', async () => {
    const { resume, version } = await makeResume('ai-failure');
    setDefaultAiProvider(null);

    const res = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${version.id}/tailor`,
      { jobId }
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(await prisma.resumeVersion.count({ where: { resumeId: resume.id } })).toBe(1);
  });

  it('rejects fabricated content with structured violations and creates no version', async () => {
    const { resume, version } = await makeResume('fabricated');
    setDefaultAiProvider(createMockAiProvider({ defaultText: FABRICATED_JSON }));

    const res = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${version.id}/tailor`,
      { jobId }
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'UNSUPPORTED_SKILL', value: 'Kubernetes' })])
    );
    expect(await prisma.resumeVersion.count({ where: { resumeId: resume.id } })).toBe(1);
    setDefaultAiProvider(null);
  });
});
