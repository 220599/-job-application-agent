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
const { generateApplicationAnswers } = await import('@jaa/core');
const { createMockAiProvider, AiError } = await import('@jaa/ai');

const TEST_USER_ID = 'answers-db-user';
const INTRUDER_ID = 'answers-db-intruder';

let jobId: string;
let resumeVersionId: string;
let applicationId: string;
let failureApplicationId: string;
let raceApplicationId: string;
let emailQuestionId: string;
let whyQuestionId: string;
let linkedinQuestionId: string;
let raceQuestionId: string;

const AI_TEXT = 'I want to build data platforms at InnovateCo, drawing on my work at Acme Corp.';

async function createQuestion(
  appId: string,
  data: { externalFieldId: string; label: string; fieldType: string; required?: boolean }
) {
  return prisma.applicationQuestion.create({
    data: {
      applicationId: appId,
      externalFieldId: data.externalFieldId,
      label: data.label,
      normalizedLabel: data.label.toLowerCase().replace(/\W+/g, '_'),
      fieldType: data.fieldType,
      required: data.required ?? false,
    },
  });
}

describe.skipIf(!HAS_DB)('answer generation (database integration)', () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: 'answers-db-user@test.local', name: 'Answers DB User' },
    });
    await prisma.user.upsert({
      where: { id: INTRUDER_ID },
      update: {},
      create: { id: INTRUDER_ID, email: 'answers-db-intruder@test.local', name: 'Intruder' },
    });

    const job = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'MOCK',
        url: `https://example.com/answers-db-job-${Date.now()}`,
        company: 'InnovateCo',
        title: 'Staff Engineer',
        description: 'Build data platforms.',
      },
    });
    jobId = job.id;

    const resume = await prisma.resume.create({
      data: {
        userId: TEST_USER_ID,
        name: 'Answers DB resume',
        originalFileName: 'resume.txt',
        fileType: 'pdf',
        storageKey: 'test/answers-db-resume.txt',
        fileSize: 10,
        mimeType: 'application/pdf',
      },
    });
    const version = await prisma.resumeVersion.create({
      data: { resumeId: resume.id, versionNumber: 1, filePath: 'test/answers-db-resume.txt' },
    });
    resumeVersionId = version.id;

    const application = await prisma.application.create({
      data: {
        userId: TEST_USER_ID,
        jobId,
        resumeVersionId,
        ats: 'MOCK',
        applicationUrl: 'https://example.com/answers-db-apply',
        status: 'FORM_INSPECTED',
      },
    });
    applicationId = application.id;

    const failureApp = await prisma.application.create({
      data: {
        userId: TEST_USER_ID,
        jobId,
        resumeVersionId,
        ats: 'MOCK',
        applicationUrl: 'https://example.com/answers-db-apply-fail',
        status: 'FORM_INSPECTED',
      },
    });
    failureApplicationId = failureApp.id;

    // Candidate profile + relations (facts for grounding).
    const profile = await prisma.candidateProfile.create({
      data: {
        userId: TEST_USER_ID,
        firstName: 'Alice',
        lastName: 'Nguyen',
        email: 'alice@example.com',
        phone: '+1 555 0100',
        linkedinUrl: 'https://linkedin.com/in/alice',
        workAuthorization: 'US_CITIZEN',
        sponsorshipRequired: true,
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
      },
    });
    await prisma.skill.create({
      data: { candidateProfileId: profile.id, name: 'TypeScript', proficiency: 'ADVANCED' },
    });

    emailQuestionId = (await createQuestion(applicationId, { externalFieldId: 'email', label: 'Email', fieldType: 'EMAIL', required: true })).id;
    whyQuestionId = (await createQuestion(applicationId, { externalFieldId: 'q_why', label: 'Why do you want to work here?', fieldType: 'TEXTAREA', required: true })).id;
    linkedinQuestionId = (await createQuestion(applicationId, { externalFieldId: 'linkedin', label: 'LinkedIn Profile', fieldType: 'TEXT' })).id;

    await createQuestion(failureApplicationId, {
      externalFieldId: 'q_why_fail',
      label: 'Why do you want to work here?',
      fieldType: 'TEXTAREA',
      required: true,
    });

    // Separate application used to simulate a concurrent approval race.
    const raceApp = await prisma.application.create({
      data: {
        userId: TEST_USER_ID,
        jobId,
        resumeVersionId,
        ats: 'MOCK',
        applicationUrl: 'https://example.com/answers-db-apply-race',
        status: 'FORM_INSPECTED',
      },
    });
    raceApplicationId = raceApp.id;
    raceQuestionId = (
      await createQuestion(raceApplicationId, {
        externalFieldId: 'q_why_race',
        label: 'Why do you want to work here?',
        fieldType: 'TEXTAREA',
        required: true,
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.application.deleteMany({
      where: { id: { in: [applicationId, failureApplicationId, raceApplicationId] } },
    });
    await prisma.resume.deleteMany({ where: { userId: TEST_USER_ID, name: 'Answers DB resume' } });
    await prisma.job.deleteMany({ where: { id: jobId } });
    await prisma.candidateProfile.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.user.deleteMany({ where: { id: { in: [TEST_USER_ID, INTRUDER_ID] } } });
    await prisma.$disconnect();
  });

  it('generates and persists answers with provenance', async () => {
    const mock = createMockAiProvider({ defaultText: AI_TEXT });
    const result = await generateApplicationAnswers({
      applicationId,
      userId: TEST_USER_ID,
      aiProvider: mock,
    });

    expect(result.status).toBe('FORM_INSPECTED'); // lifecycle unchanged (never SUBMITTED)
    expect(result.results).toHaveLength(3);

    const answers = await prisma.applicationAnswer.findMany({
      where: { questionId: { in: [emailQuestionId, whyQuestionId, linkedinQuestionId] } },
    });
    expect(answers).toHaveLength(3);

    const email = answers.find((a) => a.questionId === emailQuestionId)!;
    expect(email.answer).toBe('alice@example.com');
    expect(email.source).toBe('PROFILE');
    expect(email.needsReview).toBe(false);
    expect(email.approved).toBe(false);
    expect(Array.isArray(email.groundedFacts)).toBe(true);

    const ai = answers.find((a) => a.questionId === whyQuestionId)!;
    expect(ai.answer).toBe(AI_TEXT);
    expect(ai.source).toBe('AI');
    expect(ai.needsReview).toBe(true); // AI answers always need review
    expect(ai.approved).toBe(false); // never auto-approved
    expect(ai.confidence).toBeGreaterThan(0);
    expect((ai.groundedFacts as string[]).length).toBeGreaterThan(0);

    const linkedin = answers.find((a) => a.questionId === linkedinQuestionId)!;
    expect(linkedin.answer).toBe('https://linkedin.com/in/alice');
    expect(linkedin.source).toBe('PROFILE');
  });

  it('is idempotent: running twice creates no duplicate answers', async () => {
    const mock = createMockAiProvider({ defaultText: AI_TEXT });
    await generateApplicationAnswers({ applicationId, userId: TEST_USER_ID, aiProvider: mock });

    const answers = await prisma.applicationAnswer.findMany({
      where: { questionId: { in: [emailQuestionId, whyQuestionId, linkedinQuestionId] } },
    });
    expect(answers).toHaveLength(3); // still 3 - no duplicates (questionId unique)
    const counts = new Map<string, number>();
    for (const a of answers) counts.set(a.questionId, (counts.get(a.questionId) ?? 0) + 1);
    expect([...counts.values()]).toEqual([1, 1, 1]);
  });

  it('never overwrites a user-approved answer', async () => {
    await prisma.applicationAnswer.update({
      where: { questionId: emailQuestionId },
      data: { approved: true, answer: 'APPROVED_CUSTOM', source: 'USER_INPUT' },
    });

    const mock = createMockAiProvider({ defaultText: AI_TEXT });
    const result = await generateApplicationAnswers({
      applicationId,
      userId: TEST_USER_ID,
      aiProvider: mock,
    });

    expect(result.skippedApproved).toBe(1);
    const email = await prisma.applicationAnswer.findUnique({ where: { questionId: emailQuestionId } });
    expect(email!.answer).toBe('APPROVED_CUSTOM'); // preserved
    expect(email!.approved).toBe(true);
    expect(email!.source).toBe('USER_INPUT');
  });

  it('writes audit events without logging answers or candidate data', async () => {
    const events = await prisma.applicationEvent.findMany({ where: { applicationId } });
    const types = events.map((e) => e.eventType);
    expect(types).toContain('ANSWER_GENERATED');
    expect(types).toContain('REVIEW_REQUESTED');

    const generated = events.filter((e) => e.eventType === 'ANSWER_GENERATED');
    for (const e of generated) {
      const meta = JSON.stringify(e.metadata ?? {});
      // answer text and candidate values must never appear in event metadata
      expect(meta).not.toContain('alice@example.com');
      expect(meta).not.toContain(AI_TEXT);
      expect((e.metadata as Record<string, unknown>).answer).toBeUndefined();
    }
  });

  it('marks a failed generation needsReview and records an ERROR event', async () => {
    const failing = createMockAiProvider({
      handler: () => {
        throw new AiError('AI_TIMEOUT', 'timed out');
      },
    });
    const result = await generateApplicationAnswers({
      applicationId: failureApplicationId,
      userId: TEST_USER_ID,
      aiProvider: failing,
    });

    expect(result.errors).toBe(1);
    expect(result.needsReviewCount).toBe(1);

    const q = await prisma.applicationQuestion.findFirst({
      where: { applicationId: failureApplicationId },
    });
    const answer = await prisma.applicationAnswer.findUnique({ where: { questionId: q!.id } });
    expect(answer!.answer).toBeNull(); // not marked successful
    expect(answer!.needsReview).toBe(true);

    const errors = await prisma.applicationEvent.findMany({
      where: { applicationId: failureApplicationId, eventType: 'ERROR' },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0].metadata as Record<string, unknown>).code).toBe('AI_TIMEOUT');
  });

  it('never overwrites an answer approved while generation is running (race)', async () => {
    // The approval lands AFTER the generation run took its snapshot of existing
    // answers (the mock handler runs mid-generation). The approved answer must
    // still be preserved.
    const mock = createMockAiProvider({
      handler: async () => {
        await prisma.applicationAnswer.upsert({
          where: { questionId: raceQuestionId },
          create: {
            questionId: raceQuestionId,
            answer: 'APPROVED_DURING_RACE',
            source: 'USER_INPUT',
            approved: true,
          },
          update: { answer: 'APPROVED_DURING_RACE', source: 'USER_INPUT', approved: true },
        });
        return AI_TEXT;
      },
    });

    const result = await generateApplicationAnswers({
      applicationId: raceApplicationId,
      userId: TEST_USER_ID,
      aiProvider: mock,
    });

    const answer = await prisma.applicationAnswer.findUnique({
      where: { questionId: raceQuestionId },
    });
    expect(answer!.answer).toBe('APPROVED_DURING_RACE'); // preserved
    expect(answer!.approved).toBe(true);
    expect(answer!.source).toBe('USER_INPUT');
    expect(result.skippedApproved).toBe(1);
  });

  it('rejects generation for another user\'s application', async () => {
    const mock = createMockAiProvider({ defaultText: AI_TEXT });
    await expect(
      generateApplicationAnswers({ applicationId, userId: INTRUDER_ID, aiProvider: mock })
    ).rejects.toThrow(/APPLICATION_NOT_FOUND/);
  });
});
