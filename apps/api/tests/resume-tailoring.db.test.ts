import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Load DATABASE_URL before @jaa/database instantiates Prisma.
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/jaa_dev';

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { prisma } = await import('@jaa/database');
const {
  tailorResumeVersion,
  ResumeTailoringError,
  TAILORING_STRATEGY,
} = await import('@jaa/core');
const { createMockAiProvider, createUnavailableAiProvider, AiError } = await import('@jaa/ai');

const TEST_USER_ID = 'tailor-db-user';
const INTRUDER_ID = 'tailor-db-intruder';

let jobId: string;
let intruderJobId: string;
let jobWithoutApplicationId: string;
let applicationId: string;
let baseVersionId: string;

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
  education: [
    {
      institution: 'State University',
      degree: 'Bachelor of Science',
      fieldOfStudy: 'Computer Science',
      details: ['Coursework in Computer Science'],
    },
  ],
});

// In-memory artifact store: no filesystem side effects in tests.
const artifacts = new Map<string, string>();
const storeArtifact = async (artifact: {
  userId: string;
  resumeId: string;
  versionNumber: number;
  text: string;
}) => {
  const filePath = `memory://tailored/${artifact.resumeId}/v${artifact.versionNumber}`;
  artifacts.set(filePath, artifact.text);
  return filePath;
};

let resumeCounter = 0;
async function makeResume(label: string, opts: { text?: string | null; parsed?: unknown } = {}) {
  resumeCounter += 1;
  const resume = await prisma.resume.create({
    data: {
      userId: TEST_USER_ID,
      name: `Tailor DB resume ${label} ${resumeCounter}`,
      originalFileName: `${label}.txt`,
      fileType: 'pdf',
      storageKey: `test/tailor-db-${label}-${resumeCounter}.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
    },
  });
  const version = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: `test/tailor-db-${label}-${resumeCounter}.txt`,
      source: 'ORIGINAL',
      changeSummary: 'Original upload',
      extractedText: opts.text === undefined ? SOURCE_TEXT : opts.text,
      parsedData: opts.parsed === undefined ? SOURCE_PARSED : (opts.parsed as object),
    },
  });
  return { resume, version };
}

async function versionCount(resumeId: string): Promise<number> {
  return prisma.resumeVersion.count({ where: { resumeId } });
}

function okProvider(text = VALID_JSON) {
  return createMockAiProvider({ defaultText: text });
}

describe.skipIf(!HAS_DB)('resume tailoring (database integration)', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: 'tailor-db-user@test.local', name: 'Tailor DB User' },
    });
    await prisma.user.upsert({
      where: { id: INTRUDER_ID },
      update: {},
      create: { id: INTRUDER_ID, email: 'tailor-db-intruder@test.local', name: 'Intruder' },
    });

    // Candidate facts (shared across tests).
    const existing = await prisma.candidateProfile.findUnique({ where: { userId: TEST_USER_ID } });
    if (!existing) {
      const profile = await prisma.candidateProfile.create({
        data: {
          userId: TEST_USER_ID,
          firstName: 'Alice',
          lastName: 'Nguyen',
          email: 'alice@example.com',
          phone: '+1 555 0100',
          location: 'San Francisco, CA',
          workAuthorization: 'US_CITIZEN',
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
        url: `https://example.com/tailor-db-job-${Date.now()}`,
        company: 'InnovateCo',
        title: 'Staff Engineer',
        description: 'Build data platforms with SQL.',
        requirements: ['Strong SQL'],
        skills: ['SQL', 'Python'],
      },
    });
    jobId = job.id;

    const intruderJob = await prisma.job.create({
      data: {
        userId: INTRUDER_ID,
        source: 'MOCK',
        url: `https://example.com/tailor-db-intruder-job-${Date.now()}`,
        company: 'SecretCo',
        title: 'Secret Role',
      },
    });
    intruderJobId = intruderJob.id;

    const jobNoApp = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'MOCK',
        url: `https://example.com/tailor-db-noapp-job-${Date.now()}`,
        company: 'NoAppCo',
        title: 'Data Engineer',
      },
    });
    jobWithoutApplicationId = jobNoApp.id;

    // A base resume + version shared by ownership tests.
    const base = await makeResume('base');
    baseVersionId = base.version.id;

    // An Application exists for (user, job) so audit events can be asserted.
    const application = await prisma.application.create({
      data: {
        userId: TEST_USER_ID,
        jobId,
        resumeVersionId: base.version.id,
        ats: 'MOCK',
        applicationUrl: `https://example.com/tailor-db-apply-${Date.now()}`,
        status: 'DISCOVERED',
      },
    });
    applicationId = application.id;
  });

  // -------------------------------------------------------------------------
  // Basic tailoring + provenance
  // -------------------------------------------------------------------------

  it('creates a new immutable TAILORED version with provenance and structured content', async () => {
    const { resume, version } = await makeResume('basic');
    const result = await tailorResumeVersion({
      resumeId: resume.id,
      versionId: version.id,
      jobId,
      userId: TEST_USER_ID,
      aiProvider: okProvider(),
      storeArtifact,
    });

    expect(result.reused).toBe(false);
    expect(result.version.source).toBe('TAILORED');
    expect(result.version.versionNumber).toBe(2);
    expect(result.version.changeSummary).toBe('Tailored for Staff Engineer role at InnovateCo');

    const stored = await prisma.resumeVersion.findUnique({ where: { id: result.version.id } });
    expect(stored).not.toBeNull();

    // Provenance: source version, target job, AI-generated, strategy, validation.
    const prov = stored!.tailoring as Record<string, unknown>;
    expect(prov.sourceVersionId).toBe(version.id);
    expect(prov.jobId).toBe(jobId);
    expect(prov.strategy).toBe(TAILORING_STRATEGY);
    expect(prov.aiGenerated).toBe(true);
    expect(prov.validationStatus).toBe('PASSED');
    expect(prov.contentFormat).toBe('STRUCTURED_JSON');
    expect(typeof prov.provider).toBe('string');
    expect(typeof prov.generatedAt).toBe('string');

    // Structured content: dates/contact come from source facts, never the model.
    const parsed = stored!.parsedData as Record<string, unknown>;
    expect(parsed.contentFormat).toBe('STRUCTURED_JSON');
    expect(typeof parsed.summary).toBe('string');
    expect(parsed.skills).toEqual(['SQL', 'Python', 'TypeScript']);
    const exp = (parsed.experience as Record<string, unknown>[])[0];
    expect(exp.company).toBe('Acme Corp');
    expect(exp.title).toBe('Senior Engineer');
    expect(exp.startDate).toBe('2019-01');
    expect(exp.isCurrent).toBe(true);
    expect((exp.bullets as string[]).length).toBeGreaterThan(0);
    const edu = (parsed.education as Record<string, unknown>[])[0];
    expect(edu.institution).toBe('State University');
    expect(edu.degree).toBe('Bachelor of Science');

    // Rendered text + artifact follow the existing storage convention.
    expect(stored!.extractedText).toContain('Acme Corp');
    expect(stored!.extractedText).toContain('SUMMARY');
    expect(stored!.filePath).toBe(`memory://tailored/${resume.id}/v2`);
    expect(artifacts.has(stored!.filePath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Immutability + version numbering
  // -------------------------------------------------------------------------

  it('never modifies the source version and numbers versions 1, 2, 3', async () => {
    const { resume, version } = await makeResume('immutable');
    const before = await prisma.resumeVersion.findUnique({ where: { id: version.id } });

    await tailorResumeVersion({
      resumeId: resume.id,
      versionId: version.id,
      jobId,
      userId: TEST_USER_ID,
      aiProvider: okProvider(),
      regenerate: true,
      storeArtifact,
    });
    const second = await tailorResumeVersion({
      resumeId: resume.id,
      versionId: version.id,
      jobId,
      userId: TEST_USER_ID,
      aiProvider: okProvider(),
      regenerate: true,
      storeArtifact,
    });
    expect(second.version.versionNumber).toBe(3);

    // Every source field is byte-identical after two tailoring runs.
    const after = await prisma.resumeVersion.findUnique({ where: { id: version.id } });
    expect(after).toEqual(before);

    const all = await prisma.resumeVersion.findMany({
      where: { resumeId: resume.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(all.map((v) => v.versionNumber)).toEqual([1, 2, 3]);
    expect(all.map((v) => v.source)).toEqual(['ORIGINAL', 'TAILORED', 'TAILORED']);
    expect(new Set(all.map((v) => v.id)).size).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Ownership
  // -------------------------------------------------------------------------

  it('rejects tailoring another user\'s resume (indistinguishable from missing)', async () => {
    const { resume, version } = await makeResume('owned');
    const before = await versionCount(resume.id);
    await expect(
      tailorResumeVersion({
        resumeId: resume.id,
        versionId: version.id,
        jobId,
        userId: INTRUDER_ID,
        aiProvider: okProvider(),
        storeArtifact,
      })
    ).rejects.toMatchObject({ code: 'RESUME_NOT_FOUND' });
    await expect(
      tailorResumeVersion({
        resumeId: 'does-not-exist',
        versionId: version.id,
        jobId,
        userId: INTRUDER_ID,
        aiProvider: okProvider(),
        storeArtifact,
      })
    ).rejects.toMatchObject({ code: 'RESUME_NOT_FOUND' });
    expect(await versionCount(resume.id)).toBe(before);
  });

  it('rejects tailoring with another user\'s job', async () => {
    const { resume, version } = await makeResume('job-owned');
    const before = await versionCount(resume.id);
    await expect(
      tailorResumeVersion({
        resumeId: resume.id,
        versionId: version.id,
        jobId: intruderJobId,
        userId: TEST_USER_ID,
        aiProvider: okProvider(),
        storeArtifact,
      })
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    await expect(
      tailorResumeVersion({
        resumeId: resume.id,
        versionId: version.id,
        jobId: 'missing-job',
        userId: TEST_USER_ID,
        aiProvider: okProvider(),
        storeArtifact,
      })
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    expect(await versionCount(resume.id)).toBe(before);
  });

  it('rejects a version that does not belong to the resume', async () => {
    const a = await makeResume('ver-a');
    const b = await makeResume('ver-b');
    const before = await versionCount(a.resume.id);
    await expect(
      tailorResumeVersion({
        resumeId: a.resume.id,
        versionId: b.version.id,
        jobId,
        userId: TEST_USER_ID,
        aiProvider: okProvider(),
        storeArtifact,
      })
    ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
    expect(await versionCount(a.resume.id)).toBe(before);
  });

  // -------------------------------------------------------------------------
  // Anti-fabrication (DB level)
  // -------------------------------------------------------------------------

  it('rejects fabricated claims and creates no version', async () => {
    const cases: Array<{ label: string; content: unknown; type: string }> = [
      {
        label: 'skill',
        content: { skills: ['TypeScript', 'Kubernetes'] },
        type: 'UNSUPPORTED_SKILL',
      },
      {
        label: 'employer',
        content: {
          experience: [{ company: 'Globex Corporation', title: 'Senior Engineer', bullets: ['Built things'] }],
        },
        type: 'UNSUPPORTED_EMPLOYER',
      },
      {
        label: 'title',
        content: {
          experience: [{ company: 'Acme Corp', title: 'Chief Wizard', bullets: ['Built things'] }],
        },
        type: 'UNSUPPORTED_TITLE',
      },
      {
        label: 'degree',
        content: {
          education: [{ institution: 'State University', degree: 'PhD', fieldOfStudy: 'Computer Science' }],
        },
        type: 'UNSUPPORTED_DEGREE',
      },
      {
        label: 'certification',
        content: {
          experience: [
            { company: 'Acme Corp', title: 'Senior Engineer', bullets: ['PMP Certified Project Manager'] },
          ],
        },
        type: 'UNSUPPORTED_CERTIFICATION',
      },
      {
        label: 'metric',
        content: {
          experience: [
            { company: 'Acme Corp', title: 'Senior Engineer', bullets: ['Processed 100M records daily'] },
          ],
        },
        type: 'UNSUPPORTED_METRIC',
      },
      {
        label: 'date',
        content: {
          experience: [
            { company: 'Acme Corp', title: 'Senior Engineer', bullets: ['Led the team from 2023'] },
          ],
        },
        type: 'UNSUPPORTED_DATE',
      },
    ];

    for (const c of cases) {
      const { resume, version } = await makeResume(`fabricated-${c.label}`);
      const before = await versionCount(resume.id);
      const err = await tailorResumeVersion({
        resumeId: resume.id,
        versionId: version.id,
        jobId,
        userId: TEST_USER_ID,
        aiProvider: okProvider(JSON.stringify(c.content)),
        storeArtifact,
      }).catch((e) => e);

      expect(err, `case: ${c.label}`).toBeInstanceOf(ResumeTailoringError);
      expect(err.code, `case: ${c.label}`).toBe('VALIDATION_FAILED');
      expect(err.violations.map((v: { type: string }) => v.type), `case: ${c.label}`).toContain(c.type);
      expect(await versionCount(resume.id), `case: ${c.label}`).toBe(before);
    }
  });

  // -------------------------------------------------------------------------
  // AI failures
  // -------------------------------------------------------------------------

  it('fails safely on AI provider failures and creates no version', async () => {
    const { resume, version } = await makeResume('ai-failures');
    const before = await versionCount(resume.id);

    const cases: Array<{ provider: unknown; code: string }> = [
      { provider: null, code: 'AI_PROVIDER_UNAVAILABLE' },
      { provider: createUnavailableAiProvider(), code: 'AI_PROVIDER_UNAVAILABLE' },
      {
        provider: createMockAiProvider({
          handler: () => {
            throw new AiError('AI_TIMEOUT', 'timed out');
          },
        }),
        code: 'AI_TIMEOUT',
      },
      { provider: createMockAiProvider({ defaultText: '' }), code: 'AI_EMPTY_RESPONSE' },
      { provider: createMockAiProvider({ defaultText: 'not json' }), code: 'AI_INVALID_RESPONSE' },
    ];

    for (const c of cases) {
      const err = await tailorResumeVersion({
        resumeId: resume.id,
        versionId: version.id,
        jobId,
        userId: TEST_USER_ID,
        aiProvider: c.provider as never,
        storeArtifact,
      }).catch((e) => e);
      expect(err, `provider case: ${c.code}`).toBeInstanceOf(ResumeTailoringError);
      expect(err.code, `provider case: ${c.code}`).toBe(c.code);
    }

    expect(await versionCount(resume.id)).toBe(before);
  });

  it('rejects a source version with no usable content', async () => {
    const { resume, version } = await makeResume('empty', { text: null, parsed: null });
    const err = await tailorResumeVersion({
      resumeId: resume.id,
      versionId: version.id,
      jobId,
      userId: TEST_USER_ID,
      aiProvider: okProvider(),
      storeArtifact,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ResumeTailoringError);
    expect(err.code).toBe('EMPTY_RESUME_CONTENT');
    expect(await versionCount(resume.id)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('reuses a previous valid tailoring for the same identity', async () => {
    const { resume, version } = await makeResume('idempotent');
    const first = await tailorResumeVersion({
      resumeId: resume.id,
      versionId: version.id,
      jobId,
      userId: TEST_USER_ID,
      aiProvider: okProvider(),
      storeArtifact,
    });
    const second = await tailorResumeVersion({
      resumeId: resume.id,
      versionId: version.id,
      jobId,
      userId: TEST_USER_ID,
      aiProvider: okProvider(),
      storeArtifact,
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.version.id).toBe(first.version.id);
    expect(second.validation.valid).toBe(true);
    expect(await versionCount(resume.id)).toBe(2);

    // A deliberate new run is still possible.
    const third = await tailorResumeVersion({
      resumeId: resume.id,
      versionId: version.id,
      jobId,
      userId: TEST_USER_ID,
      aiProvider: okProvider(),
      regenerate: true,
      storeArtifact,
    });
    expect(third.reused).toBe(false);
    expect(third.version.versionNumber).toBe(3);
    expect(await versionCount(resume.id)).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Auditability
  // -------------------------------------------------------------------------

  it('records a RESUME_TAILORED event with safe metadata on the related application', async () => {
    const { resume, version } = await makeResume('audit');
    const result = await tailorResumeVersion({
      resumeId: resume.id,
      versionId: version.id,
      jobId,
      userId: TEST_USER_ID,
      aiProvider: okProvider(),
      storeArtifact,
    });

    const events = await prisma.applicationEvent.findMany({
      where: { applicationId, eventType: 'RESUME_TAILORED' },
    });
    const event = events.find((e) => {
      const meta = e.metadata as Record<string, unknown>;
      return meta.targetVersionId === result.version.id;
    });
    expect(event).toBeTruthy();
    const meta = event!.metadata as Record<string, unknown>;
    expect(meta.sourceVersionId).toBe(version.id);
    expect(meta.targetVersionId).toBe(result.version.id);
    expect(meta.jobId).toBe(jobId);
    expect(meta.strategy).toBe(TAILORING_STRATEGY);
    expect(meta.validationStatus).toBe('PASSED');

    // Metadata never contains resume text, prompts, or personal data.
    const serialized = JSON.stringify(event!.metadata);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('data pipelines');
    expect(serialized).not.toContain('STRICT GROUNDING');
  });

  it('records an ERROR event (no resume text) when tailoring fails', async () => {
    const { resume, version } = await makeResume('audit-fail');
    const err = await tailorResumeVersion({
      resumeId: resume.id,
      versionId: version.id,
      jobId,
      userId: TEST_USER_ID,
      aiProvider: okProvider(JSON.stringify({ skills: ['Kubernetes'] })),
      storeArtifact,
    }).catch((e) => e);
    expect(err.code).toBe('VALIDATION_FAILED');

    const events = await prisma.applicationEvent.findMany({
      where: { applicationId, eventType: 'ERROR' },
    });
    const event = events.find((e) => {
      const meta = e.metadata as Record<string, unknown>;
      return meta.sourceVersionId === version.id;
    });
    expect(event).toBeTruthy();
    const meta = event!.metadata as Record<string, unknown>;
    expect(meta.code).toBe('VALIDATION_FAILED');
    expect(meta.sourceVersionId).toBe(version.id);
    expect(meta.violationTypes).toEqual(['UNSUPPORTED_SKILL']);
    expect(JSON.stringify(event!.metadata)).not.toContain('Kubernetes');
  });

  it('records no event when the user has no application for the job', async () => {
    const { resume, version } = await makeResume('audit-none');
    const before = await prisma.applicationEvent.count({ where: { userId: TEST_USER_ID } });
    await tailorResumeVersion({
      resumeId: resume.id,
      versionId: version.id,
      jobId: jobWithoutApplicationId,
      userId: TEST_USER_ID,
      aiProvider: okProvider(),
      storeArtifact,
    });
    const after = await prisma.applicationEvent.count({ where: { userId: TEST_USER_ID } });
    expect(after).toBe(before);
    // Provenance is still persisted on the version itself.
    const created = await prisma.resumeVersion.findFirst({
      where: { resumeId: resume.id, source: 'TAILORED' },
    });
    expect((created!.tailoring as Record<string, unknown>).jobId).toBe(jobWithoutApplicationId);
  });
});
