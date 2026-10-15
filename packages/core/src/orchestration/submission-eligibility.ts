import { prisma } from '@jaa/database';
import type { Application, ResumeVersion } from '@jaa/database';
import type { AtsAdapter, AtsRegistry } from '@jaa/ats';

import { provenanceOf } from '../resume-review';
import {
  findUnresolvedSubmissionAttempt,
  verifyApprovalForSubmission,
} from '../application-submission';
import {
  assertAnyRealSubmissionCapabilityEnabled,
  assertSubmissionTarget,
  resolveSubmissionMode,
  type SubmissionTargetMode,
} from '../submission-policy';
import { OrchestrationError } from './types';
import { createPreparationRegistry } from './registry';

// The target policy (mock vs real Greenhouse) lives in the leaf module
// ../submission-policy so the core submission workflow can share it without
// an import cycle. The mock helpers are re-exported here to keep the
// @jaa/core surface stable for existing callers/tests.
export { isLoopbackUrl, assertMockSubmissionTarget } from '../submission-policy';

/**
 * Phase 15A - server-side submission safety gate.
 *
 * Submission must be IMPOSSIBLE unless every condition below holds. All
 * checks happen here, never in the frontend, and they run BOTH when a
 * submission is requested (POST /api/applications/:id/submit) and again in
 * the worker right before the external submission attempt:
 *
 *   1. the application exists and belongs to the authenticated user;
 *   2. it is not already submitted (handled idempotently by the caller);
 *   3. no earlier submission attempt has an UNKNOWN outcome;
 *   4. it is in the APPROVED state - which only the explicit human approval
 *      action can produce (never inferred from resume approval,
 *      preparation, matching, form filling, or AI confidence), AND that
 *      approval still covers the EXACT current application content
 *      (target, resume version, questions/answers snapshot - Phase 15D;
 *      any drift invalidates the approval and requires a new one);
 *   5. its resume version is APPROVED (PENDING/REJECTED block);
 *   6. its tailoring validation passed when tailoring provenance is present;
 *   7. every required question has a valid answer: present, not awaiting
 *      human review, and consistent with the recorded field options;
 *   8. the target is a LOOPBACK mock ATS (Phase 15A is mock-only: no code
 *      path can ever submit a real application);
 *   9. the application URL parses as http(s) and a registered ATS adapter
 *      supports it.
 */

export interface SubmissionEligibilityParams {
  applicationId: string;
  userId: string;
  registry?: AtsRegistry;
}

export interface SubmissionEligibilityResult {
  application: Application & { resumeVersion: ResumeVersion | null };
  adapter: AtsAdapter;
  provider: string;
  applicationUrl: string;
  /** MOCK (loopback) or REAL (controlled Greenhouse) - server decided. */
  submissionMode: SubmissionTargetMode;
}

/** A required question that blocks submission, with a machine-readable code. */
export interface SubmissionAnswerProblem {
  questionId: string;
  code: 'REQUIRED_ANSWER_MISSING' | 'ANSWER_NEEDS_REVIEW' | 'ANSWER_INVALID';
}

/**
 * Validate every required question's answer.
 *
 * A required question passes only when an answer exists and is non-empty,
 * human review is resolved (an answer flagged `needsReview` must be
 * explicitly approved), and - when the field recorded options - the answer
 * is one of the offered options (the existing validation surface).
 */
export async function checkSubmissionAnswers(
  applicationId: string
): Promise<SubmissionAnswerProblem[]> {
  const questions = await prisma.applicationQuestion.findMany({
    where: { applicationId, required: true },
    include: { answer: true },
  });

  const problems: SubmissionAnswerProblem[] = [];
  for (const question of questions) {
    const answer = question.answer;
    const text = answer?.answer?.trim() ?? '';
    if (!answer || text.length === 0) {
      problems.push({ questionId: question.id, code: 'REQUIRED_ANSWER_MISSING' });
      continue;
    }
    if (answer.needsReview && !answer.approved) {
      problems.push({ questionId: question.id, code: 'ANSWER_NEEDS_REVIEW' });
      continue;
    }
    const options = Array.isArray(question.options)
      ? (question.options as { value?: string; label?: string }[])
      : null;
    if (options && options.length > 0) {
      const target = text.toLowerCase();
      const valid = options.some(
        (option) =>
          (option.value ?? '').trim().toLowerCase() === target ||
          (option.label ?? '').trim().toLowerCase() === target
      );
      if (!valid) {
        problems.push({ questionId: question.id, code: 'ANSWER_INVALID' });
      }
    }
  }
  return problems;
}

/**
 * Resume + answers readiness: every human-supplied input must be complete
 * and resolved before submission.
 */
export async function checkSubmissionReadiness(
  application: Application & { resumeVersion: ResumeVersion | null }
): Promise<void> {
  const version = application.resumeVersion;
  if (!version) {
    throw new OrchestrationError('RESUME_NOT_APPROVED', 'Application has no resume version');
  }
  if (version.reviewStatus !== 'APPROVED') {
    throw new OrchestrationError(
      'RESUME_NOT_APPROVED',
      'The resume version must be approved before submission'
    );
  }

  const provenance = provenanceOf(version.tailoring);
  if (provenance && provenance['validationStatus'] !== 'PASSED') {
    throw new OrchestrationError(
      'TAILORING_NOT_VALIDATED',
      'The resume version did not pass tailoring validation'
    );
  }

  const answerProblems = await checkSubmissionAnswers(application.id);
  if (answerProblems.length > 0) {
    const first = answerProblems[0];
    // Question IDs only - never question text or answer text (no PII).
    const questionIds = answerProblems.map((problem) => problem.questionId).join(', ');
    throw new OrchestrationError(
      first.code,
      `Submission blocked by ${answerProblems.length} invalid required answer(s) (${first.code}): ${questionIds}`
    );
  }
}

/**
 * Resolve and validate the submission target: URL shape, the mock-only
 * policy (fail closed - refused before any provider is even consulted),
 * and a registered ATS adapter.
 */
export async function resolveSubmissionTarget(params: {
  application: Application & { resumeVersion: ResumeVersion | null };
  registry?: AtsRegistry;
}): Promise<{
  adapter: AtsAdapter;
  provider: string;
  applicationUrl: string;
  submissionMode: SubmissionTargetMode;
}> {
  const application = params.application;
  const rawUrl = application.applicationUrl;
  if (!rawUrl) {
    throw new OrchestrationError(
      'APPLICATION_URL_MISSING',
      'Application has no application URL'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new OrchestrationError(
      'INVALID_APPLICATION_URL',
      'Application URL is not a valid URL'
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OrchestrationError(
      'INVALID_APPLICATION_URL',
      'Application URL must use http or https'
    );
  }

  // Decide the mode from the URL alone: loopback is the mock boundary,
  // anything else is a real target. A real target is refused BEFORE any
  // provider is consulted unless at least one real-submission capability
  // is enabled (fail closed) - SSRF protection is never weakened by the
  // submission path. The full per-provider policy runs below once the
  // provider is resolved (each provider's own capability flag).
  const submissionMode = resolveSubmissionMode(rawUrl);
  if (submissionMode === 'REAL') {
    assertAnyRealSubmissionCapabilityEnabled(); // real capability must be on (fail closed)
  }

  const registry = params.registry ?? createPreparationRegistry();
  const adapter = registry.findForUrl(rawUrl);
  if (!adapter) {
    throw new OrchestrationError(
      'UNSUPPORTED_ATS',
      'No supported ATS provider can handle this application URL'
    );
  }

  // Full target policy against the resolved provider: mock (loopback + opt-in)
  // or real (Greenhouse-only, non-loopback, SSRF-validated).
  assertSubmissionTarget(rawUrl, adapter.provider);

  return { adapter, provider: adapter.provider, applicationUrl: rawUrl, submissionMode };
}

/**
 * Everything EXCEPT the approval/ledger state machine: re-verified by the
 * worker right before the external submission attempt (defense in depth).
 */
export async function checkSubmissionSafetyGate(params: {
  application: Application & { resumeVersion: ResumeVersion | null };
  registry?: AtsRegistry;
}): Promise<{
  adapter: AtsAdapter;
  provider: string;
  applicationUrl: string;
  submissionMode: SubmissionTargetMode;
}> {
  await checkSubmissionReadiness(params.application);
  return resolveSubmissionTarget(params);
}

/**
 * The full submission gate (API request path): ownership, unsafe-target
 * refusal (fail closed, before anything else target-related), approval
 * state, unknown-outcome ledger, plus the readiness/safety checks.
 */
export async function checkSubmissionEligibility(
  params: SubmissionEligibilityParams
): Promise<SubmissionEligibilityResult> {
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { resumeVersion: true },
  });

  // Missing and foreign applications are indistinguishable on purpose.
  if (!application || application.userId !== params.userId) {
    throw new OrchestrationError('APPLICATION_NOT_FOUND', 'Application not found');
  }

  if (application.status === 'SUBMITTED') {
    throw new OrchestrationError(
      'APPLICATION_TERMINAL',
      'Application is already submitted'
    );
  }

  // An unresolved attempt = a previous worker may have submitted without
  // recording it. Never queue another submission on top of that.
  const unresolvedAttemptId = await findUnresolvedSubmissionAttempt(application.id);
  if (unresolvedAttemptId) {
    throw new OrchestrationError(
      'SUBMISSION_OUTCOME_UNKNOWN',
      'A previous submission attempt has an unknown outcome; submission is stopped and requires human resolution'
    );
  }

  // Unsafe/unsupported targets are refused FIRST (fail closed): an
  // invalid URL, a non-loopback URL (any real ATS), or an unknown provider
  // is a rejection regardless of any other state.
  const { adapter, provider, applicationUrl, submissionMode } = await resolveSubmissionTarget({
    application,
    registry: params.registry,
  });

  // The only submittable state is APPROVED - produced exclusively by the
  // explicit human approval action.
  if (application.status !== 'APPROVED') {
    if (application.status === 'FORM_INSPECTED' || application.status === 'READY_FOR_REVIEW') {
      throw new OrchestrationError(
        'HUMAN_APPROVAL_REQUIRED',
        'The application must be explicitly approved for submission before it can be submitted'
      );
    }
    if (
      application.status === 'WITHDRAWN' ||
      application.status === 'REJECTED' ||
      application.status === 'INTERVIEW' ||
      application.status === 'OFFER'
    ) {
      throw new OrchestrationError(
        'APPLICATION_TERMINAL',
        `Application is in terminal status ${application.status} and cannot be submitted`
      );
    }
    throw new OrchestrationError(
      'APPLICATION_STATE_NOT_SUBMITTABLE',
      `Application status ${application.status} cannot be submitted`
    );
  }

  // Approval integrity (Phase 15D): the explicit approval must cover the
  // exact content that would be submitted. Drift (a changed answer, resume
  // swap/edit, changed target) or an unverifiable approval invalidates the
  // approval here - a new explicit approval is always required.
  await verifyApprovalForSubmission(application);

  await checkSubmissionReadiness(application);

  return { application, adapter, provider, applicationUrl, submissionMode };
}
