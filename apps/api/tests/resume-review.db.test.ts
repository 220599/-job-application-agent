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
  loadReviewView,
  approveResumeVersion,
  rejectResumeVersion,
  createHumanEditedVersion,
  ResumeReviewError,
  HUMAN_EDIT_STRATEGY,
} = await import('@jaa/core');

const TEST_USER_ID = 'review-db-user';
const INTRUDER_ID = 'review-db-intruder';

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

function tailoredProvenance(sourceVersionId: string, jobId: string) {
  return {
    sourceVersionId,
    jobId,
    strategy: 'JOB_ALIGNED_V1',
    aiGenerated: true,
    provider: 'mock',
    validationStatus: 'PASSED',
    contentFormat: 'STRUCTURED_JSON',
    promptVersion: 'v1',
    generatedAt: '2026-10-03T10:00:00.000Z',
  };
}

// In-memory artifact store - tests leave no filesystem side effects.
const artifacts = new Map<string, unknown>();
const storeArtifact = async (artifact: {
  userId: string;
  resumeId: string;
  versionNumber: number;
  content: unknown;
  text: string;
}) => {
  const filePath = `mem://${artifact.resumeId}-v${artifact.versionNumber}-${Date.now()}`;
  artifacts.set(filePath, artifact);
  return filePath;
};

let resumeCounter = 0;
let jobId: string;

async function makeUser(id: string, email: string, name: string) {
  await prisma.user.upsert({ where: { id }, update: {}, create: { id, email, name } });
}

async function makeResume(label: string) {
  resumeCounter += 1;
  const resume = await prisma.resume.create({
    data: {
      userId: TEST_USER_ID,
      name: `Review resume ${label} ${resumeCounter}`,
      originalFileName: `${label}.txt`,
      fileType: 'pdf',
      storageKey: `test/review-${label}-${resumeCounter}.txt`,
      fileSize: 10,
      mimeType: 'application/pdf',
    },
  });
  const version = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: `test/review-${label}-${resumeCounter}.txt`,
      source: 'ORIGINAL',
      extractedText: SOURCE_TEXT,
      parsedData: SOURCE_PARSED as object,
    },
  });
  return { resume, version };
}

async function makeTailoredVersion(
  resumeId: string,
  overrides: { tailoring?: object } = {}
) {
  const agg = await prisma.resumeVersion.aggregate({
    where: { resumeId },
    _max: { versionNumber: true },
  });
  const versionNumber = (agg._max.versionNumber ?? 0) + 1;
  return prisma.resumeVersion.create({
    data: {
      resumeId,
      versionNumber,
      filePath: `mem://${resumeId}-v${versionNumber}`,
      source: 'TAILORED',
      changeSummary: 'Tailored for Staff Engineer role at InnovateCo',
      extractedText: 'Alice Nguyen\nSenior Engineer\nSQL, Python, TypeScript',
      parsedData: TAILORED_PARSED as object,
      tailoring: (overrides.tailoring ?? tailoredProvenance('', jobId)) as object,
    },
  });
}

async function expectReviewError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ResumeReviewError);
    expect((err as InstanceType<typeof ResumeReviewError>).code).toBe(code);
    return err as InstanceType<typeof ResumeReviewError>;
  }
  throw new Error(`expected ResumeReviewError(${code}) but the call succeeded`);
}

describe.skipIf(!HAS_DB)('resume review workflow', () => {
  beforeAll(async () => {
    await makeUser(TEST_USER_ID, 'review-db-user@test.local', 'Review User');
    await makeUser(INTRUDER_ID, 'review-db-intruder@test.local', 'Intruder');

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
        url: `https://example.com/review-db-job-${Date.now()}`,
        company: 'InnovateCo',
        title: 'Staff Engineer',
        location: 'Remote',
        description: 'Build data platforms with SQL.',
      },
    });
    jobId = job.id;
  });

  // -------------------------------------------------------------------------
  // Eligibility
  // -------------------------------------------------------------------------

  it('loads the review view for a valid tailored version', async () => {
    const { resume, version } = await makeResume('view');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, jobId),
    });

    const view = await loadReviewView({
      resumeId: resume.id,
      versionId: tailored.id,
      userId: TEST_USER_ID,
    });

    expect(view.resume).toEqual({ id: resume.id, name: resume.name });
    expect(view.version.versionNumber).toBe(2);
    expect(view.version.source).toBe('TAILORED');
    expect(view.review.reviewStatus).toBe('PENDING');
    expect(view.sourceVersion.id).toBe(version.id);
    expect(view.sourceVersion.versionNumber).toBe(1);
    expect(view.job).toEqual({
      id: jobId,
      company: 'InnovateCo',
      title: 'Staff Engineer',
      location: 'Remote',
      employmentType: null,
      workMode: null,
    });
    expect(view.provenance).toEqual({
      sourceVersionId: version.id,
      jobId,
      strategy: 'JOB_ALIGNED_V1',
      aiGenerated: true,
      provider: 'mock',
      validationStatus: 'PASSED',
      contentFormat: 'STRUCTURED_JSON',
      promptVersion: 'v1',
      generatedAt: '2026-10-03T10:00:00.000Z',
    });
    expect(view.validationStatus).toBe('PASSED');
    expect(view.tailoredContent.skills).toEqual(['SQL', 'Python', 'TypeScript']);
    expect(view.sourceContent.experience[0].bullets.length).toBeGreaterThan(0);
    expect(view.changedSections).toContain('summary');
  });

  it('refuses to review or approve an ORIGINAL version as tailored', async () => {
    const { resume, version } = await makeResume('original');
    await expectReviewError(
      loadReviewView({ resumeId: resume.id, versionId: version.id, userId: TEST_USER_ID }),
      'NOT_REVIEWABLE'
    );
    await expectReviewError(
      approveResumeVersion({ resumeId: resume.id, versionId: version.id, userId: TEST_USER_ID }),
      'NOT_REVIEWABLE'
    );
  });

  it('refuses to approve failed or invalid tailoring', async () => {
    const { resume, version } = await makeResume('failed');
    const failed = await makeTailoredVersion(resume.id, {
      tailoring: { ...tailoredProvenance(version.id, jobId), validationStatus: 'FAILED' },
    });
    await expectReviewError(
      approveResumeVersion({ resumeId: resume.id, versionId: failed.id, userId: TEST_USER_ID }),
      'NOT_REVIEWABLE'
    );

    const noProvenance = await makeTailoredVersion(resume.id, { tailoring: {} });
    await expectReviewError(
      approveResumeVersion({ resumeId: resume.id, versionId: noProvenance.id, userId: TEST_USER_ID }),
      'NOT_REVIEWABLE'
    );

    expect(await prisma.resumeVersion.count({ where: { resumeId: resume.id } })).toBe(3);
  });

  it('refuses to review when the source version is missing', async () => {
    const { resume, version } = await makeResume('orphan');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance('ver-does-not-exist', jobId),
    });
    await expectReviewError(
      approveResumeVersion({ resumeId: resume.id, versionId: tailored.id, userId: TEST_USER_ID }),
      'NOT_REVIEWABLE'
    );
    void version;
  });

  // -------------------------------------------------------------------------
  // Ownership
  // -------------------------------------------------------------------------

  it('never lets another user review, approve, or reject (indistinguishable 404)', async () => {
    const { resume, version } = await makeResume('ownership');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, jobId),
    });

    await expectReviewError(
      loadReviewView({ resumeId: resume.id, versionId: tailored.id, userId: INTRUDER_ID }),
      'RESUME_NOT_FOUND'
    );
    await expectReviewError(
      approveResumeVersion({ resumeId: resume.id, versionId: tailored.id, userId: INTRUDER_ID }),
      'RESUME_NOT_FOUND'
    );
    await expectReviewError(
      rejectResumeVersion({ resumeId: resume.id, versionId: tailored.id, userId: INTRUDER_ID }),
      'RESUME_NOT_FOUND'
    );

    const fresh = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });
    expect(fresh!.reviewStatus).toBe('PENDING');
  });

  // -------------------------------------------------------------------------
  // Approve / reject
  // -------------------------------------------------------------------------

  it('approves a tailored version and keeps the source version immutable', async () => {
    const { resume, version } = await makeResume('approve');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, jobId),
    });
    const sourceBefore = await prisma.resumeVersion.findUnique({ where: { id: version.id } });
    const tailoredBefore = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });

    const result = await approveResumeVersion({
      resumeId: resume.id,
      versionId: tailored.id,
      userId: TEST_USER_ID,
    });

    expect(result.changed).toBe(true);
    expect(result.review.reviewStatus).toBe('APPROVED');
    expect(result.review.reviewedAt).not.toBeNull();
    expect(result.review.reviewedBy).toBe(TEST_USER_ID);

    // Review state persists.
    const view = await loadReviewView({
      resumeId: resume.id,
      versionId: tailored.id,
      userId: TEST_USER_ID,
    });
    expect(view.review.reviewStatus).toBe('APPROVED');
    expect(view.review.reviewedAt).toBe(result.review.reviewedAt);

    // The source version and the tailored version content are unchanged -
    // only the review columns moved.
    const sourceAfter = await prisma.resumeVersion.findUnique({ where: { id: version.id } });
    expect(sourceAfter).toEqual(sourceBefore);
    const tailoredAfter = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });
    expect(tailoredAfter!.extractedText).toEqual(tailoredBefore!.extractedText);
    expect(tailoredAfter!.parsedData).toEqual(tailoredBefore!.parsedData);
    expect(tailoredAfter!.tailoring).toEqual(tailoredBefore!.tailoring);
    expect(tailoredAfter!.filePath).toEqual(tailoredBefore!.filePath);
  });

  it('rejects a tailored version with a note and keeps the version', async () => {
    const { resume, version } = await makeResume('reject');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, jobId),
    });

    const result = await rejectResumeVersion({
      resumeId: resume.id,
      versionId: tailored.id,
      userId: TEST_USER_ID,
      note: 'Tone does not match',
    });

    expect(result.changed).toBe(true);
    expect(result.review.reviewStatus).toBe('REJECTED');
    expect(result.review.reviewNotes).toBe('Tone does not match');

    // The tailored version is kept, never deleted.
    const fresh = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });
    expect(fresh).not.toBeNull();
    expect(fresh!.reviewStatus).toBe('REJECTED');
    expect(fresh!.reviewNotes).toBe('Tone does not match');
    expect(await prisma.resumeVersion.count({ where: { resumeId: resume.id } })).toBe(2);
  });

  it('is idempotent: repeated approval and repeated rejection do not corrupt state', async () => {
    const { resume, version } = await makeResume('idempotent-approve');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, jobId),
    });

    const first = await approveResumeVersion({
      resumeId: resume.id,
      versionId: tailored.id,
      userId: TEST_USER_ID,
    });
    const second = await approveResumeVersion({
      resumeId: resume.id,
      versionId: tailored.id,
      userId: TEST_USER_ID,
    });
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.review.reviewedAt).toBe(first.review.reviewedAt);

    const { resume: resume2, version: version2 } = await makeResume('idempotent-reject');
    const tailored2 = await makeTailoredVersion(resume2.id, {
      tailoring: tailoredProvenance(version2.id, jobId),
    });
    const firstReject = await rejectResumeVersion({
      resumeId: resume2.id,
      versionId: tailored2.id,
      userId: TEST_USER_ID,
      note: 'First note',
    });
    const secondReject = await rejectResumeVersion({
      resumeId: resume2.id,
      versionId: tailored2.id,
      userId: TEST_USER_ID,
      note: 'Second note',
    });
    expect(firstReject.changed).toBe(true);
    expect(secondReject.changed).toBe(false);
    // The original decision and note are preserved.
    expect(secondReject.review.reviewNotes).toBe('First note');
  });

  it('rejects conflicting decisions (reject after approve, approve after reject)', async () => {
    const { resume, version } = await makeResume('conflict');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, jobId),
    });

    await approveResumeVersion({ resumeId: resume.id, versionId: tailored.id, userId: TEST_USER_ID });
    await expectReviewError(
      rejectResumeVersion({
        resumeId: resume.id,
        versionId: tailored.id,
        userId: TEST_USER_ID,
        note: 'changed my mind',
      }),
      'REVIEW_CONFLICT'
    );

    const { resume: resume2, version: version2 } = await makeResume('conflict-2');
    const tailored2 = await makeTailoredVersion(resume2.id, {
      tailoring: tailoredProvenance(version2.id, jobId),
    });
    await rejectResumeVersion({
      resumeId: resume2.id,
      versionId: tailored2.id,
      userId: TEST_USER_ID,
    });
    await expectReviewError(
      approveResumeVersion({ resumeId: resume2.id, versionId: tailored2.id, userId: TEST_USER_ID }),
      'REVIEW_CONFLICT'
    );

    // States are untouched by the conflicting attempts.
    const a = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });
    const b = await prisma.resumeVersion.findUnique({ where: { id: tailored2.id } });
    expect(a!.reviewStatus).toBe('APPROVED');
    expect(b!.reviewStatus).toBe('REJECTED');
    expect(b!.reviewNotes).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------

  it('records an audit event with ids/statuses only - never resume content', async () => {
    const { resume, version } = await makeResume('audit');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, jobId),
    });
    const application = await prisma.application.create({
      data: {
        userId: TEST_USER_ID,
        jobId,
        resumeVersionId: tailored.id,
        ats: 'MOCK',
        status: 'DISCOVERED',
      },
    });

    await approveResumeVersion({ resumeId: resume.id, versionId: tailored.id, userId: TEST_USER_ID });
    // Conflicting decision - must not log a rejection event.
    await rejectResumeVersion({
      resumeId: resume.id,
      versionId: tailored.id,
      userId: TEST_USER_ID,
    }).catch(() => undefined);

    const { resume: resume2, version: version2 } = await makeResume('audit-2');
    const tailored2 = await makeTailoredVersion(resume2.id, {
      tailoring: tailoredProvenance(version2.id, jobId),
    });
    await rejectResumeVersion({
      resumeId: resume2.id,
      versionId: tailored2.id,
      userId: TEST_USER_ID,
      note: 'Sensitive rejection reason',
    });

    const events = await prisma.applicationEvent.findMany({
      where: { applicationId: application.id },
    });
    const approved = events.filter((e) => e.eventType === 'RESUME_APPROVED');
    const rejected = events.filter((e) => e.eventType === 'RESUME_REJECTED');
    expect(approved.length).toBe(1);
    expect(rejected.length).toBe(1); // the conflicting reject emitted nothing

    const metadata = JSON.stringify(approved[0].metadata);
    expect(metadata).toContain(tailored.id);
    expect(metadata).toContain(version.id);
    expect(metadata).toContain(jobId);
    const rejectedMetadata = JSON.stringify(rejected[0].metadata);
    expect(rejectedMetadata).toContain(tailored2.id);
    // Never resume text, candidate facts, prompts, answers, or PII.
    for (const leak of [
      'Alice',
      'Nguyen',
      'alice@example.com',
      'Senior Engineer',
      'Built data pipelines',
      'SQL',
      'State University',
      'Sensitive rejection reason',
    ]) {
      expect(metadata).not.toContain(leak);
      expect(rejectedMetadata).not.toContain(leak);
    }

    // Application status is NEVER changed by resume review.
    const freshApp = await prisma.application.findUnique({ where: { id: application.id } });
    expect(freshApp!.status).toBe('DISCOVERED');
  });

  it('emits no audit event when the user has no application for the job', async () => {
    // A dedicated job with no Application row for this user.
    const soloJob = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'MOCK',
        url: `https://example.com/review-db-solo-${Date.now()}`,
        company: 'SoloCo',
        title: 'Solo Role',
      },
    });
    const { resume, version } = await makeResume('no-app');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, soloJob.id),
    });
    const before = await prisma.applicationEvent.count({ where: { userId: TEST_USER_ID } });

    await approveResumeVersion({ resumeId: resume.id, versionId: tailored.id, userId: TEST_USER_ID });

    const after = await prisma.applicationEvent.count({ where: { userId: TEST_USER_ID } });
    expect(after).toBe(before);
  });

  // -------------------------------------------------------------------------
  // Human editing
  // -------------------------------------------------------------------------

  it('creates a NEW immutable version for human edits; old and source versions stay unchanged', async () => {
    const { resume, version } = await makeResume('edit');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, jobId),
    });
    const sourceBefore = await prisma.resumeVersion.findUnique({ where: { id: version.id } });
    const tailoredBefore = await prisma.resumeVersion.findUnique({ where: { id: tailored.id } });

    const result = await createHumanEditedVersion({
      resumeId: resume.id,
      versionId: tailored.id,
      userId: TEST_USER_ID,
      content: {
        summary: 'Engineer specializing in SQL and Python.',
        skills: ['SQL', 'Python'],
        experience: [
          {
            company: 'Acme Corp',
            title: 'Senior Engineer',
            bullets: ['Built data pipelines with SQL and Python'], // one bullet removed
          },
        ],
      },
      storeArtifact,
    });

    expect(result.version.source).toBe('USER_EDITED');
    expect(result.version.versionNumber).toBe(3);
    expect(result.provenance.strategy).toBe(HUMAN_EDIT_STRATEGY);
    expect(result.provenance.aiGenerated).toBe(false);
    expect(result.provenance.sourceVersionId).toBe(tailored.id);
    expect(result.provenance.editedBy).toBe(TEST_USER_ID);
    // The edited version starts PENDING and must itself be approved.
    expect(result.review.reviewStatus).toBe('PENDING');

    // Old tailored version and source version are byte-identical.
    expect(await prisma.resumeVersion.findUnique({ where: { id: version.id } })).toEqual(sourceBefore);
    expect(await prisma.resumeVersion.findUnique({ where: { id: tailored.id } })).toEqual(
      tailoredBefore
    );

    // Dates and contact details in the new version come from the source
    // facts - never from the edit.
    const created = await prisma.resumeVersion.findUnique({ where: { id: result.version.id } });
    const parsed = created!.parsedData as {
      email: string;
      experience: Array<{ startDate: string; company: string }>;
    };
    expect(parsed.email).toBe('alice@example.com');
    expect(parsed.experience[0].startDate).toBe('2019-01');

    // The new version is reviewable through the same workspace.
    const view = await loadReviewView({
      resumeId: resume.id,
      versionId: result.version.id,
      userId: TEST_USER_ID,
    });
    expect(view.sourceVersion.id).toBe(tailored.id);
    expect(view.review.reviewStatus).toBe('PENDING');
    expect(view.provenance.humanEdited).toBe(true);
  });

  it('rejects invalid human edits with the Phase 11 anti-fabrication validator and creates no version', async () => {
    const { resume, version } = await makeResume('edit-invalid');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, jobId),
    });
    const before = await prisma.resumeVersion.count({ where: { resumeId: resume.id } });

    // Fabricated skill.
    const skillErr = await expectReviewError(
      createHumanEditedVersion({
        resumeId: resume.id,
        versionId: tailored.id,
        userId: TEST_USER_ID,
        content: { skills: ['TypeScript', 'Kubernetes'] },
        storeArtifact,
      }),
      'VALIDATION_FAILED'
    );
    expect(skillErr.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'UNSUPPORTED_SKILL', value: 'Kubernetes' })])
    );

    // Fabricated job title.
    const titleErr = await expectReviewError(
      createHumanEditedVersion({
        resumeId: resume.id,
        versionId: tailored.id,
        userId: TEST_USER_ID,
        content: {
          experience: [{ company: 'Acme Corp', title: 'VP of Engineering', bullets: ['Led things'] }],
        },
        storeArtifact,
      }),
      'VALIDATION_FAILED'
    );
    expect(titleErr.violations.map((v) => v.type)).toContain('UNSUPPORTED_TITLE');

    // Fabricated metric.
    const metricErr = await expectReviewError(
      createHumanEditedVersion({
        resumeId: resume.id,
        versionId: tailored.id,
        userId: TEST_USER_ID,
        content: { summary: 'Managed a budget of 12 million dollars.' },
        storeArtifact,
      }),
      'VALIDATION_FAILED'
    );
    expect(metricErr.violations.map((v) => v.type)).toContain('UNSUPPORTED_METRIC');

    expect(await prisma.resumeVersion.count({ where: { resumeId: resume.id } })).toBe(before);
  });

  it('refuses to edit a version that is not reviewable', async () => {
    const { resume, version } = await makeResume('edit-original');
    await expectReviewError(
      createHumanEditedVersion({
        resumeId: resume.id,
        versionId: version.id,
        userId: TEST_USER_ID,
        content: { summary: 'Anything' },
        storeArtifact,
      }),
      'NOT_REVIEWABLE'
    );
  });

  it('refuses edits from another user', async () => {
    const { resume, version } = await makeResume('edit-ownership');
    const tailored = await makeTailoredVersion(resume.id, {
      tailoring: tailoredProvenance(version.id, jobId),
    });
    await expectReviewError(
      createHumanEditedVersion({
        resumeId: resume.id,
        versionId: tailored.id,
        userId: INTRUDER_ID,
        content: { skills: ['SQL'] },
        storeArtifact,
      }),
      'RESUME_NOT_FOUND'
    );
  });
});
