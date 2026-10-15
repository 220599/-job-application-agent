/**
 * Phase 10 - answer generation orchestration.
 *
 * Per question: classify -> candidate facts -> deterministic answer OR grounded
 * AI generation -> confidence + provenance + needsReview -> ApplicationAnswer.
 *
 * The DB workflow is idempotent (ApplicationAnswer.questionId is unique), never
 * overwrites a user-approved answer, never advances the application lifecycle
 * (stays pre-submission), and writes audit events WITHOUT logging answer text or
 * candidate data.
 */
import { prisma } from '@jaa/database';
import type { Prisma } from '@prisma/client';
import { getDefaultAiProvider, type AiProvider } from '@jaa/ai';

import type {
  AnswerDraft,
  AnswerSource,
  AnswerStrategy,
  CandidateContext,
  GenerateAnswerOptions,
  JobContext,
  QuestionCategory,
  QuestionInput,
} from './types';
import { classifyQuestion } from './classify';
import { deterministicAnswer } from './deterministic';
import { aiAnswer } from './ai';
import { buildCandidateContext } from './facts';
import { OrchestrationError } from '../orchestration/types';
import { invalidateApproval } from '../application-submission';

export async function generateAnswerForQuestion(
  question: QuestionInput,
  ctx: CandidateContext,
  options: GenerateAnswerOptions = {}
): Promise<AnswerDraft> {
  const classification = classifyQuestion(question);
  let draft: AnswerDraft;

  if (classification.strategy === 'DETERMINISTIC') {
    draft = deterministicAnswer(classification.category, question, ctx);
  } else if (classification.strategy === 'AI') {
    draft = await aiAnswer(
      classification.category,
      question,
      ctx,
      options.job,
      options.aiProvider
    );
  } else {
    // MANUAL: file uploads and unknown questions are never auto-answered.
    draft = {
      questionId: '',
      category: classification.category,
      strategy: 'MANUAL',
      answer: null,
      source: 'SYSTEM',
      confidence: 0.1,
      groundedFacts: [],
      needsReview: true,
      reviewReason:
        classification.category === 'OTHER' ? 'UNSUPPORTED_QUESTION' : 'MANUAL_FIELD',
      reasoning: 'This field is not auto-answered (file upload or unknown question).',
      errorCode: null,
    };
  }

  return { ...draft, questionId: question.id };
}

// ============================================================================
// Database workflow
// ============================================================================

export interface GenerateApplicationAnswersParams {
  applicationId: string;
  /** When provided, ownership is enforced (mismatch -> APPLICATION_NOT_FOUND). */
  userId?: string;
  /** Restrict to specific questions; default all questions on the application. */
  questionIds?: string[];
  /** Injected AI provider (mocked in tests). */
  aiProvider?: AiProvider | null;
}

export interface GeneratedAnswerSummary {
  questionId: string;
  category: QuestionCategory;
  strategy: AnswerStrategy;
  source: AnswerSource;
  confidence: number;
  answer: string | null;
  groundedFacts: string[];
  needsReview: boolean;
  reviewReason?: string | null;
  errorCode?: string | null;
  /** True when a user-approved answer was preserved (not regenerated). */
  skippedApproved: boolean;
}

export interface GenerateApplicationAnswersResult {
  applicationId: string;
  /** Unchanged lifecycle status (answer generation never submits). */
  status: string;
  results: GeneratedAnswerSummary[];
  generated: number;
  skippedApproved: number;
  needsReviewCount: number;
  errors: number;
}

function toQuestionInput(q: {
  id: string;
  label: string;
  normalizedLabel: string | null;
  fieldType: string;
  required: boolean;
  options: unknown;
  section: string | null;
  locator: unknown;
}): QuestionInput {
  const options = Array.isArray(q.options)
    ? (q.options as { value: string; label: string }[])
    : null;
  const locator =
    q.locator && typeof q.locator === 'object'
      ? (q.locator as { cssSelector?: string; attributes?: Record<string, string> })
      : null;
  return {
    id: q.id,
    label: q.label,
    normalizedLabel: q.normalizedLabel,
    fieldType: q.fieldType,
    required: q.required,
    options,
    section: q.section,
    locator,
  };
}

function toJobContext(job: {
  company: string;
  title: string;
  location: string | null;
  description: string | null;
  requirements: unknown;
  responsibilities: unknown;
  skills: unknown;
} | null): JobContext | null {
  if (!job) return null;
  const arr = (v: unknown): string[] | null => (Array.isArray(v) ? (v as string[]) : null);
  return {
    company: job.company,
    title: job.title,
    location: job.location,
    description: job.description,
    requirements: arr(job.requirements),
    responsibilities: arr(job.responsibilities),
    skills: arr(job.skills),
  };
}

/** Summary row for an answer that was preserved because it is user approved. */
function approvedSummary(
  questionId: string,
  category: QuestionCategory,
  row: { answer: string | null; source: string; confidence: number | null; groundedFacts: unknown; needsReview: boolean }
): GeneratedAnswerSummary {
  return {
    questionId,
    category,
    strategy: 'MANUAL',
    source: (row.source as AnswerSource) ?? 'USER_INPUT',
    confidence: row.confidence ?? 1,
    answer: row.answer,
    groundedFacts: Array.isArray(row.groundedFacts) ? (row.groundedFacts as string[]) : [],
    needsReview: row.needsReview,
    skippedApproved: true,
  };
}

/**
 * Generate (or regenerate) answers for an application's questions.
 *
 * Guarantees:
 *  - ownership is enforced when `userId` is supplied;
 *  - idempotent: one ApplicationAnswer per question (unique questionId);
 *  - user-approved answers are never overwritten;
 *  - a failed/optional generation marks the question needsReview and does NOT
 *    fail the application;
 *  - the application lifecycle is never advanced (no submission).
 */
export async function generateApplicationAnswers(
  params: GenerateApplicationAnswersParams
): Promise<GenerateApplicationAnswersResult> {
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { job: true, questions: true, resumeVersion: true },
  });

  // Ownership: not-found and not-owned are indistinguishable (no existence leak).
  if (!application || (params.userId && application.userId !== params.userId)) {
    throw new Error(`APPLICATION_NOT_FOUND: ${params.applicationId}`);
  }

  // Phase 15D - content integrity: in-flight and submitted applications are
  // immutable (a submission is never affected by later rewrites).
  if (application.status === 'SUBMITTING' || application.status === 'SUBMITTED') {
    throw new OrchestrationError(
      'APPLICATION_TERMINAL',
      `Application content cannot be changed while the application is ${application.status}`
    );
  }

  const profile = await prisma.candidateProfile.findUnique({
    where: { userId: application.userId },
    include: { experience: true, education: true, skills: true },
  });

  const ctx = buildCandidateContext({
    profile: profile
      ? {
          firstName: profile.firstName,
          lastName: profile.lastName,
          preferredName: profile.preferredName,
          email: profile.email,
          phone: profile.phone,
          location: profile.location,
          city: profile.city,
          state: profile.state,
          country: profile.country,
          zipCode: profile.zipCode,
          linkedinUrl: profile.linkedinUrl,
          githubUrl: profile.githubUrl,
          portfolioUrl: profile.portfolioUrl,
          websiteUrl: profile.websiteUrl,
          workAuthorization: profile.workAuthorization,
          sponsorshipRequired: profile.sponsorshipRequired,
          willingToRelocate: profile.willingToRelocate,
          preferredWorkMode: profile.preferredWorkMode,
          preferredLocations: profile.preferredLocations,
          desiredRoles: profile.desiredRoles,
          desiredSalaryMin: profile.desiredSalaryMin,
          desiredSalaryMax: profile.desiredSalaryMax,
          summary: profile.summary,
        }
      : null,
    experience: profile?.experience ?? [],
    education: profile?.education ?? [],
    skills: profile?.skills ?? [],
    resume: application.resumeVersion
      ? {
          extractedText: application.resumeVersion.extractedText,
          parsedData: application.resumeVersion.parsedData as Record<string, unknown> | null,
        }
      : null,
  });

  const job = toJobContext(application.job);

  const allQuestions = application.questions.map(toQuestionInput);
  const targetQuestions = params.questionIds
    ? allQuestions.filter((q) => params.questionIds!.includes(q.id))
    : allQuestions;

  const existing = await prisma.applicationAnswer.findMany({
    where: { questionId: { in: targetQuestions.map((q) => q.id) } },
  });
  const answerByQuestion = new Map(existing.map((a) => [a.questionId, a]));

  const results: GeneratedAnswerSummary[] = [];
  let generated = 0;
  let skippedApproved = 0;
  let needsReviewCount = 0;
  let errors = 0;
  // Phase 15D - approval integrity: tracks whether any ANSWER TEXT actually
  // changed (the snapshot binds answer text).
  let answerTextChanged = false;

  for (const question of targetQuestions) {
    const prior = answerByQuestion.get(question.id);

    // User-approved answers take precedence and are never overwritten.
    if (prior?.approved) {
      skippedApproved += 1;
      results.push(approvedSummary(question.id, classifyQuestion(question).category, prior));
      continue;
    }

    const draft = await generateAnswerForQuestion(question, ctx, {
      // undefined -> resolve the configured default provider; explicit null ->
      // no provider (AI questions then need review instead of fabricating).
      aiProvider: params.aiProvider === undefined ? getDefaultAiProvider() : params.aiProvider,
      job,
    });

    // Persist idempotently (one ApplicationAnswer per question via the unique
    // questionId) with an ATOMIC `approved: false` guard: a user-approved
    // answer is never overwritten - including one approved concurrently after
    // the snapshot read above.
    const data = {
      answer: draft.answer,
      source: draft.source,
      confidence: draft.confidence,
      groundedFacts: draft.groundedFacts as unknown as Prisma.InputJsonValue,
      needsReview: draft.needsReview,
    };
    const generatedAt = new Date();

    const guarded = await prisma.applicationAnswer.updateMany({
      where: { questionId: question.id, approved: false },
      data: { ...data, generatedAt },
    });

    if (guarded.count === 0) {
      // No unapproved row was updated: either no answer exists yet (create it)
      // or the row became approved concurrently (preserve it).
      let concurrentRow = await prisma.applicationAnswer.findUnique({
        where: { questionId: question.id },
      });

      if (!concurrentRow) {
        try {
          await prisma.applicationAnswer.create({
            data: { questionId: question.id, ...data, approved: false, generatedAt },
          });
        } catch (err) {
          // Unique-questionId race with a concurrent writer: that writer's row
          // stands. Re-check it and never clobber an approved answer.
          concurrentRow = await prisma.applicationAnswer.findUnique({
            where: { questionId: question.id },
          });
          if (!concurrentRow) throw err;
        }
      }

      if (concurrentRow?.approved) {
        skippedApproved += 1;
        results.push(approvedSummary(question.id, draft.category, concurrentRow));
        continue;
      }
    }

    if ((prior?.answer ?? null) !== (draft.answer ?? null)) {
      answerTextChanged = true;
    }

    // Audit event: never logs answer text or candidate data.
    await prisma.applicationEvent.create({
      data: {
        applicationId: application.id,
        userId: application.userId,
        eventType: 'ANSWER_GENERATED',
        status: application.status,
        message: `Answer generated for question (${draft.category})`,
        metadata: {
          questionId: question.id,
          category: draft.category,
          strategy: draft.strategy,
          source: draft.source,
          confidence: draft.confidence,
          needsReview: draft.needsReview,
          answerLength: draft.answer ? draft.answer.length : 0,
          ...(draft.errorCode ? { errorCode: draft.errorCode } : {}),
        },
      },
    });

    if (draft.errorCode) {
      errors += 1;
      await prisma.applicationEvent.create({
        data: {
          applicationId: application.id,
          userId: application.userId,
          eventType: 'ERROR',
          status: application.status,
          message: `Answer generation failed (${draft.errorCode})`,
          metadata: {
            questionId: question.id,
            category: draft.category,
            code: draft.errorCode,
          },
        },
      });
    }
    if (draft.needsReview) needsReviewCount += 1;
    if (draft.answer !== null) generated += 1;

    results.push({
      questionId: question.id,
      category: draft.category,
      strategy: draft.strategy,
      source: draft.source,
      confidence: draft.confidence,
      answer: draft.answer,
      groundedFacts: draft.groundedFacts,
      needsReview: draft.needsReview,
      reviewReason: draft.reviewReason,
      errorCode: draft.errorCode,
      skippedApproved: false,
    });
  }

  // Phase 15D - approval integrity: approved content changed -> the approval
  // no longer covers the application and is invalidated (never silently).
  // The user must explicitly approve the NEW content before anything can be
  // submitted. A regeneration that changes no answer text leaves the
  // approval intact.
  if (application.status === 'APPROVED' && answerTextChanged) {
    await invalidateApproval({ application, code: 'APPROVAL_STALE', drift: ['ANSWERS'] });
  }

  // One summary review signal when anything needs human review.
  if (needsReviewCount > 0) {
    await prisma.applicationEvent.create({
      data: {
        applicationId: application.id,
        userId: application.userId,
        eventType: 'REVIEW_REQUESTED',
        status: application.status,
        message: `${needsReviewCount} answer(s) require human review`,
        metadata: { needsReviewCount },
      },
    });
  }

  return {
    applicationId: application.id,
    status: application.status,
    results,
    generated,
    skippedApproved,
    needsReviewCount,
    errors,
  };
}
