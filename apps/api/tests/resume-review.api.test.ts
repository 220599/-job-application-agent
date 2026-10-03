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
const express = (await import('express')).default;
const { default: resumesRouter } = await import('../src/routes/resumes');
const { userMiddleware, errorHandler } = await import('../src/middleware/auth');

const TEST_USER_ID = 'review-api-user';
const INTRUDER_ID = 'review-api-intruder';

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

const TAILORED_PARSED = {
  summary: 'Senior engineer focused on distributed systems, specializing in SQL and Python.',
  skills: ['SQL', 'Python', 'TypeScript'],
  experience: [
    {
      company: 'Acme Corp',
      title: 'Senior Engineer',
      startDate: '2019-01',
      endDate: null,
      isCurrent: true,
      description: 'Built data pipelines with SQL and Python\nReduced report time by 50%',
      bullets: ['Built data pipelines with SQL and Python', 'Reduced report time by 50%'],
    },
  ],
  education: [
    {
      institution: 'State University',
      degree: 'Bachelor of Science',
      fieldOfStudy: 'Computer Science',
      details: [],
    },
  ],
  contentFormat: 'STRUCTURED_JSON',
};

let authenticatedPort: number;
let barePort: number;
let servers: Array<{ close: () => void }> = [];
let jobId: string;

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
    post: (urlPath: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

let resumeCounter = 0;
async function makeTailored(label: string) {
  resumeCounter += 1;
  const resume = await prisma.resume.create({
    data: {
      userId: TEST_USER_ID,
      name: `Review API resume ${label} ${resumeCounter}`,
      originalFileName: `${label}.txt`,
      fileType: 'pdf',
      storageKey: `test/review-api-${label}-${resumeCounter}.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
    },
  });
  const source = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: `test/review-api-${label}-${resumeCounter}.txt`,
      source: 'ORIGINAL',
      extractedText: SOURCE_TEXT,
      parsedData: SOURCE_PARSED as object,
    },
  });
  const tailored = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 2,
      filePath: `mem://${resume.id}-v2`,
      source: 'TAILORED',
      changeSummary: 'Tailored for Staff Engineer role at InnovateCo',
      extractedText: 'Alice Nguyen\nSenior Engineer\nSQL, Python, TypeScript',
      parsedData: TAILORED_PARSED as object,
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
  return { resume, source, tailored };
}

describe.skipIf(!HAS_DB)('resume review API', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: 'review-api-user@test.local', name: 'Review API User' },
    });
    await prisma.user.upsert({
      where: { id: INTRUDER_ID },
      update: {},
      create: { id: INTRUDER_ID, email: 'review-api-intruder@test.local', name: 'Intruder' },
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
        url: `https://example.com/review-api-job-${Date.now()}`,
        company: 'InnovateCo',
        title: 'Staff Engineer',
        description: 'Build data platforms with SQL.',
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
    // Remove artifacts the edit endpoint wrote via the default local store so
    // the test run leaves no filesystem side effects in the working tree.
    const fs = await import('fs/promises');
    const dir = path.join(process.cwd(), 'uploads', 'resumes');
    try {
      for (const file of await fs.readdir(dir)) {
        if (file.startsWith('review-api-user-') && file.endsWith('-tailored.json')) {
          await fs.rm(path.join(dir, file), { force: true });
        }
      }
    } catch {
      // Directory may not exist when all tests were skipped.
    }
  });

  it('requires authentication (no auth context -> 401)', async () => {
    const { resume, tailored } = await makeTailored('no-auth');

    const view = await api(barePort).get(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review`
    );
    expect(view.status).toBe(401);
    expect((await view.json()).error.code).toBe('UNAUTHORIZED');

    const approve = await api(barePort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/approve`
    );
    expect(approve.status).toBe(401);

    const fresh = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });
    expect(fresh!.reviewStatus).toBe('PENDING');
  });

  it('returns the review payload without storage paths, prompts, or secrets', async () => {
    const { resume, source, tailored } = await makeTailored('payload');

    const res = await api(authenticatedPort).get(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review`
    );
    expect(res.status).toBe(200);
    const view = (await res.json()).data;

    expect(view.resume).toEqual({ id: resume.id, name: resume.name });
    expect(view.version.id).toBe(tailored.id);
    expect(view.version.versionNumber).toBe(2);
    expect(view.review.reviewStatus).toBe('PENDING');
    expect(view.sourceVersion.id).toBe(source.id);
    expect(view.job).toMatchObject({ company: 'InnovateCo', title: 'Staff Engineer' });
    expect(view.provenance).toMatchObject({
      sourceVersionId: source.id,
      jobId,
      strategy: 'JOB_ALIGNED_V1',
      aiGenerated: true,
      validationStatus: 'PASSED',
    });
    expect(view.validationStatus).toBe('PASSED');
    expect(view.sourceContent.skills).toEqual(['TypeScript', 'SQL', 'Python']);
    expect(view.tailoredContent.skills).toEqual(['SQL', 'Python', 'TypeScript']);
    expect(view.changedSections).toContain('summary');

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('filePath');
    expect(serialized).not.toContain('storageKey');
    expect(serialized).not.toContain('uploads');
    expect(serialized).not.toContain('"prompt"');
    expect(serialized).not.toContain('SYSTEM PROMPT');
  });

  it('returns 404 (never leaks existence) for inaccessible resources', async () => {
    const { resume, source, tailored } = await makeTailored('ownership');

    // Missing resume.
    const missingResume = await api(authenticatedPort).get(
      `/api/resumes/nope/versions/${tailored.id}/review`
    );
    expect(missingResume.status).toBe(404);
    expect((await missingResume.json()).error.code).toBe('RESUME_NOT_FOUND');

    // Missing version.
    const missingVersion = await api(authenticatedPort).get(
      `/api/resumes/${resume.id}/versions/nope/review`
    );
    expect(missingVersion.status).toBe(404);
    expect((await missingVersion.json()).error.code).toBe('VERSION_NOT_FOUND');

    // Another user's resume - identical response, no existence leak.
    process.env.USER_ID = INTRUDER_ID;
    const foreign = await api(authenticatedPort).get(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review`
    );
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.code).toBe('RESUME_NOT_FOUND');

    const foreignApprove = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/approve`
    );
    expect(foreignApprove.status).toBe(404);
    expect((await foreignApprove.json()).error.code).toBe('RESUME_NOT_FOUND');
    process.env.USER_ID = TEST_USER_ID;

    // State untouched by any of the failed attempts.
    const fresh = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });
    expect(fresh!.reviewStatus).toBe('PENDING');
    void source;
  });

  it('refuses to review an ORIGINAL version (422 NOT_REVIEWABLE)', async () => {
    const { resume, source } = await makeTailored('original');

    const view = await api(authenticatedPort).get(
      `/api/resumes/${resume.id}/versions/${source.id}/review`
    );
    expect(view.status).toBe(422);
    expect((await view.json()).error.code).toBe('NOT_REVIEWABLE');

    const approve = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${source.id}/review/approve`
    );
    expect(approve.status).toBe(422);
    expect((await approve.json()).error.code).toBe('NOT_REVIEWABLE');
  });

  it('approves a tailored version and duplicate approval is a safe no-op', async () => {
    const { resume, tailored } = await makeTailored('approve');

    const res = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/approve`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.changed).toBe(true);
    expect(body.data.review.reviewStatus).toBe('APPROVED');
    expect(body.data.review.reviewedBy).toBe(TEST_USER_ID);
    expect(body.data.review.reviewedAt).not.toBeNull();

    // Duplicate approval: idempotent success, state unchanged.
    const repeat = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/approve`
    );
    expect(repeat.status).toBe(200);
    const repeatBody = await repeat.json();
    expect(repeatBody.data.changed).toBe(false);
    expect(repeatBody.data.review.reviewedAt).toBe(body.data.review.reviewedAt);

    const fresh = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });
    expect(fresh!.reviewStatus).toBe('APPROVED');
  });

  it('rejects with an optional note and rejects invalid review states with 409', async () => {
    const { resume, tailored } = await makeTailored('reject');

    const res = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/reject`,
      { note: 'Tone does not match' }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.changed).toBe(true);
    expect(body.data.review.reviewStatus).toBe('REJECTED');
    expect(body.data.review.reviewNotes).toBe('Tone does not match');

    // Duplicate rejection: idempotent, original note preserved.
    const repeat = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/reject`,
      { note: 'Another note' }
    );
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).data.changed).toBe(false);
    const fresh = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });
    expect(fresh!.reviewNotes).toBe('Tone does not match');
    expect(await prisma.resumeVersion.count({ where: { resumeId: resume.id } })).toBe(2);

    // Conflicting decision -> 409 REVIEW_CONFLICT.
    const conflict = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/approve`
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('REVIEW_CONFLICT');

    // And the reverse conflict on a fresh version.
    const { resume: resume2, tailored: tailored2 } = await makeTailored('reject-conflict');
    await api(authenticatedPort).post(
      `/api/resumes/${resume2.id}/versions/${tailored2.id}/review/approve`
    );
    const rejectAfterApprove = await api(authenticatedPort).post(
      `/api/resumes/${resume2.id}/versions/${tailored2.id}/review/reject`,
      { note: 'nope' }
    );
    expect(rejectAfterApprove.status).toBe(409);
    expect((await rejectAfterApprove.json()).error.code).toBe('REVIEW_CONFLICT');
  });

  it('rejects invalid request bodies with VALIDATION_ERROR', async () => {
    const { resume, tailored } = await makeTailored('bad-body');

    const longNote = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/reject`,
      { note: 'x'.repeat(501) }
    );
    expect(longNote.status).toBe(400);
    expect((await longNote.json()).error.code).toBe('VALIDATION_ERROR');

    const wrongType = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/reject`,
      { note: 42 }
    );
    expect(wrongType.status).toBe(400);

    const unknownField = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/edit`,
      { summary: 'ok', graduationDate: '2020' }
    );
    expect(unknownField.status).toBe(400);
    expect((await unknownField.json()).error.code).toBe('VALIDATION_ERROR');

    const fresh = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });
    expect(fresh!.reviewStatus).toBe('PENDING');
  });

  it('creates a new immutable version for human edits', async () => {
    const { resume, source, tailored } = await makeTailored('edit');

    const res = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/edit`,
      {
        summary: 'Engineer specializing in SQL and Python.',
        skills: ['SQL', 'Python'],
        experience: [
          {
            company: 'Acme Corp',
            title: 'Senior Engineer',
            bullets: ['Built data pipelines with SQL and Python'],
          },
        ],
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.version.source).toBe('USER_EDITED');
    expect(body.data.version.versionNumber).toBe(3);
    expect(body.data.review.reviewStatus).toBe('PENDING');
    expect(body.data.provenance.strategy).toBe('HUMAN_EDIT_V1');
    expect(body.data.provenance.aiGenerated).toBe(false);

    // Old versions untouched.
    const freshSource = await prisma.resumeVersion.findUnique({ where: { id: source.id } });
    expect(freshSource!.reviewStatus).toBe('PENDING');
    const freshTailored = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });
    expect(freshTailored!.reviewStatus).toBe('PENDING');
    expect((freshTailored!.parsedData as { summary: string }).summary).toBe(
      (TAILORED_PARSED as { summary: string }).summary
    );

    // The new version opens in the review workspace (PENDING).
    const view = await api(authenticatedPort).get(
      `/api/resumes/${resume.id}/versions/${body.data.version.id}/review`
    );
    expect(view.status).toBe(200);
    expect((await view.json()).data.review.reviewStatus).toBe('PENDING');
  });

  it('rejects fabricated human edits with structured violations and creates no version', async () => {
    const { resume, tailored } = await makeTailored('edit-fabricated');

    const res = await api(authenticatedPort).post(
      `/api/resumes/${resume.id}/versions/${tailored.id}/review/edit`,
      { skills: ['TypeScript', 'Kubernetes'] }
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'UNSUPPORTED_SKILL', value: 'Kubernetes' }),
      ])
    );
    expect(await prisma.resumeVersion.count({ where: { resumeId: resume.id } })).toBe(2);
  });
});
