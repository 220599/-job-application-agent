import { UnrecoverableError } from 'bullmq';
import { prisma } from '@jaa/database';
import type { AutomationRun } from '@prisma/client';
import { preparationJobPayloadSchema, type PreparationJobPayload } from '@jaa/shared';
import { isAtsError, type AtsRegistry } from '@jaa/ats';

import {
  submitApplication,
  isSimulatedWorkerCrash,
  findUnresolvedSubmissionAttempt,
  recordUnknownSubmissionOutcome,
  type SubmitApplicationParams,
  type SubmitApplicationResult,
} from '../application-submission';
import { claimPreparationRun, touchAutomationRun } from './runs';
import { createPreparationRegistry } from './registry';
import { checkSubmissionSafetyGate } from './submission-eligibility';
import {
  OrchestrationError,
  SUBMISSION_MAX_ATTEMPTS,
  DEFAULT_RUN_STALE_MS,
  safeErrorMessage,
} from './types';
import { classifyPreparationError, type ErrorClassification } from './handler';

/**
 * Phase 15A - submission worker job handler (orchestration only).
 *
 * Mirrors the Phase 13 preparation handler exactly - same payload contract,
 * same run claim, same bounded retry classification - and delegates to the
 * core submitApplication workflow, which owns every submission state change
 * and the crash-safety attempt ledger. The handler never submits anything
 * itself and never fills answers or uploads resumes.
 */

/** Test seam shape - defaults to the real core submitApplication. */
export type SubmissionJobFn = (
  params: SubmitApplicationParams
) => Promise<SubmitApplicationResult>;

/**
 * Classification for submission failures.
 *
 * The preparation classification is deliberately reused: its retryable set
 * (PROVIDER_UNAVAILABLE, TRANSIENT_FAILURE, ENQUEUE_FAILED) is exactly
 * right for submission too. On top of that, this wrapper HARDENS the one
 * safety-critical rule: an unknown submission outcome (SUBMISSION_UNCONFIRMED
 * / SUBMISSION_OUTCOME_UNKNOWN) and every deterministic submission failure
 * (SUBMISSION_FAILED, CAPTCHA_DETECTED, SECURITY_CHALLENGE) must NEVER be
 * retried automatically - retrying an unknown outcome could submit twice.
 */
function classifySubmissionError(err: unknown): ErrorClassification {
  if (isAtsError(err)) {
    if (err.code === 'SUBMISSION_UNCONFIRMED') {
      return { code: 'SUBMISSION_OUTCOME_UNKNOWN', retryable: false };
    }
    if (err.code === 'SUBMISSION_FAILED') {
      return { code: 'SUBMISSION_FAILED', retryable: false };
    }
  }
  const classification = classifyPreparationError(err);
  if (
    classification.code === 'SUBMISSION_OUTCOME_UNKNOWN' ||
    classification.code === 'SUBMISSION_FAILED' ||
    classification.code === 'CAPTCHA_DETECTED' ||
    classification.code === 'SECURITY_CHALLENGE'
  ) {
    return { code: classification.code, retryable: false };
  }
  return classification;
}

export interface SubmissionJobContext {
  /** 1-based attempt number (BullMQ attemptsMade + 1). */
  attempt?: number;
  registry?: AtsRegistry;
  /** Test/dev only: allow loopback mock ATS servers. */
  allowPrivateUrls?: boolean;
  staleMs?: number;
  heartbeatMs?: number;
  /** Test seam - defaults to the real core submitApplication. */
  submit?: SubmissionJobFn;
}

export interface SubmissionJobOutcome {
  applicationId: string;
  automationRunId: string;
  outcome: 'SUBMITTED' | 'SKIPPED';
  reason?: string;
  provider?: string;
  submissionAttemptId?: string;
  /** Provider confirmation reference; null when the provider exposed none. */
  externalApplicationId?: string | null;
}

async function auditEvent(params: {
  applicationId: string;
  userId: string;
  eventType: 'ERROR' | 'USER_INTERRUPTED';
  message: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await prisma.applicationEvent
    .create({
      data: {
        applicationId: params.applicationId,
        userId: params.userId,
        eventType: params.eventType,
        message: params.message,
        // IDs, statuses, codes only - never answers, resume text, or PII.
        metadata: params.metadata as object,
      },
    })
    .catch(() => undefined);
}

async function failRun(
  run: AutomationRun,
  code: string,
  message: string
): Promise<void> {
  await prisma.automationRun
    .updateMany({
      where: { id: run.id, status: { in: ['QUEUED', 'RUNNING', 'FAILED'] } },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: safeErrorMessage(message),
        metadata: { errorCode: code },
      },
    })
    .catch(() => undefined);
}

/**
 * Process one mock submission job. Throws BullMQ's UnrecoverableError for
 * deterministic failures and unknown outcomes (never retried) and a plain
 * Error for retryable failures (bounded exponential backoff). A retry can
 * NEVER blindly submit a second time: the attempt ledger in
 * submitApplication refuses whenever a previous attempt's outcome is
 * unknown.
 */
export async function handleSubmissionJob(
  rawPayload: unknown,
  ctx: SubmissionJobContext = {}
): Promise<SubmissionJobOutcome> {
  const attempt = ctx.attempt ?? 1;
  const staleMs = ctx.staleMs ?? DEFAULT_RUN_STALE_MS;

  // 1. Payload contract: identifiers only, strict. Anything else is a
  //    deterministic failure and must never be retried.
  const parsed = preparationJobPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new UnrecoverableError(
      'INVALID_JOB_PAYLOAD: job payload must contain only applicationId and automationRunId'
    );
  }
  const payload: PreparationJobPayload = parsed.data;

  // 2. Load the durable state from PostgreSQL (never from the job payload).
  const run = await prisma.automationRun.findUnique({
    where: { id: payload.automationRunId },
  });
  if (!run) {
    throw new UnrecoverableError(
      `AUTOMATION_RUN_NOT_FOUND: ${safeErrorMessage(payload.automationRunId)}`
    );
  }
  if (run.applicationId !== payload.applicationId) {
    throw new UnrecoverableError('RUN_MISMATCH: job payload does not match the automation run');
  }

  const application = await prisma.application.findUnique({
    where: { id: payload.applicationId },
    include: { resumeVersion: true },
  });
  if (!application || application.userId !== run.userId) {
    await failRun(run, 'APPLICATION_NOT_FOUND', 'Application not found');
    throw new UnrecoverableError('APPLICATION_NOT_FOUND');
  }

  // 3. Crash-safety ledger FIRST (before the run claim): an unresolved
  //    attempt marker means a previous worker may have submitted without
  //    recording it (or a request failed in transit). This check must run
  //    even while the run still looks ACTIVE from the crashed attempt - a
  //    retry must never blindly submit a second time. The outcome is
  //    recorded as UNKNOWN and the job fails terminally.
  const unresolvedAttemptId = await findUnresolvedSubmissionAttempt(application.id);
  if (unresolvedAttemptId) {
    await recordUnknownSubmissionOutcome({
      application,
      reason:
        'A previous submission attempt has no recorded outcome; the application may or may not have been submitted, so no new submission is attempted',
    });
    await failRun(
      run,
      'SUBMISSION_OUTCOME_UNKNOWN',
      'A previous submission attempt has an unknown outcome'
    );
    await auditEvent({
      applicationId: application.id,
      userId: application.userId,
      eventType: 'ERROR',
      message: 'Submission stopped: a previous attempt has an unknown outcome (never resubmitted blindly)',
      metadata: {
        automationRunId: run.id,
        code: 'SUBMISSION_OUTCOME_UNKNOWN',
        submissionAttemptId: unresolvedAttemptId,
        attempt,
        retryable: false,
      },
    });
    throw new UnrecoverableError(
      'SUBMISSION_OUTCOME_UNKNOWN: a previous submission attempt has an unknown outcome; submission is stopped and requires human resolution'
    );
  }

  // 4. Re-verify the safety gate server side (resume approved, answers
  //    complete, mock-only target, supported ATS). Eligibility can change
  //    between enqueue and processing. The approval/ledger state machine is
  //    enforced by submitApplication itself (fresh attempts need APPROVED,
  //    retries continue resolved attempts only).
  try {
    await checkSubmissionSafetyGate({
      application,
      registry: ctx.registry ?? createPreparationRegistry(),
    });
  } catch (err) {
    if (err instanceof OrchestrationError) {
      await failRun(run, err.code, err.message);
      await prisma.application
        .updateMany({
          where: { id: application.id, status: { in: ['APPROVED', 'FAILED'] } },
          data: { errorCode: err.code, errorMessage: safeErrorMessage(err.message) },
        })
        .catch(() => undefined);
      await auditEvent({
        applicationId: application.id,
        userId: application.userId,
        eventType: 'ERROR',
        message: `Submission gate failed: ${err.code}`,
        metadata: { automationRunId: run.id, code: err.code, attempt, retryable: false },
      });
      throw new UnrecoverableError(`${err.code}: ${err.message}`);
    }
    throw err;
  }

  // 5. Claim the run: conditional QUEUED/FAILED (or stale RUNNING) ->
  //    RUNNING. The database serializes this transition, so two workers can
  //    never process submissions for the same application simultaneously.
  const claim = await claimPreparationRun({ runId: run.id, staleMs });
  if (!claim.claimed) {
    if (claim.reason === 'CANCELLED') {
      // The user cancelled this submission before it started.
      await auditEvent({
        applicationId: application.id,
        userId: application.userId,
        eventType: 'USER_INTERRUPTED',
        message: 'Submission was cancelled by the user before it started',
        metadata: { automationRunId: run.id },
      });
    }
    return {
      applicationId: payload.applicationId,
      automationRunId: run.id,
      outcome: 'SKIPPED',
      reason: claim.reason,
    };
  }

  // Heartbeat: keep `updatedAt` fresh while the browser works, so a live
  // submission is never mistaken for a crashed one.
  const heartbeatMs =
    ctx.heartbeatMs ?? Math.min(60_000, Math.max(1_000, Math.floor(staleMs / 3)));
  const heartbeat = setInterval(() => {
    void touchAutomationRun(run.id);
  }, heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    // 6. Delegate to the core submission workflow. It re-checks the attempt
    //    ledger and the target policy, claims one durable attempt, drives
    //    the real adapter through @jaa/browser to the loopback mock ATS
    //    (MOCK) or a recognized Greenhouse form (REAL, server capability
    //    only), verifies the provider confirmation, and owns every state
    //    change (SUBMITTING -> SUBMITTED / FAILED).
    const submit = ctx.submit ?? submitApplication;
    const result = await submit({
      applicationId: application.id,
      userId: run.userId,
      registry: ctx.registry ?? createPreparationRegistry(),
      allowPrivateUrls: ctx.allowPrivateUrls,
      attempt,
    });

    if (result.outcome === 'SKIPPED') {
      // The run was claimed but no submission was attempted (e.g. the
      // application was already submitted) - finalize it, never leave it
      // RUNNING.
      await prisma.automationRun
        .updateMany({
          where: { id: run.id, status: 'RUNNING' },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            metadata: { finalStatus: 'SKIPPED', reason: result.reason },
          },
        })
        .catch(() => undefined);
      return {
        applicationId: application.id,
        automationRunId: run.id,
        outcome: 'SKIPPED',
        reason: result.reason,
      };
    }

    // Success: the workflow already marked the run COMPLETED; make sure a
    // custom submit cannot leave it RUNNING.
    const fresh = await prisma.automationRun.findUnique({ where: { id: run.id } });
    if (fresh && fresh.status === 'RUNNING') {
      await prisma.automationRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          metadata: {
            provider: result.provider,
            finalStatus: 'SUBMITTED',
            submissionAttemptId: result.submissionAttemptId,
          },
        },
      });
    }

    return {
      applicationId: application.id,
      automationRunId: run.id,
      outcome: 'SUBMITTED',
      provider: result.provider,
      submissionAttemptId: result.submissionAttemptId,
      externalApplicationId: result.externalApplicationId,
    };
  } catch (err) {
    // A simulated crash must propagate with ZERO bookkeeping - it stands for
    // the process dying at that exact boundary.
    if (isSimulatedWorkerCrash(err)) throw err;

    // 6. Failure: classify, persist a SAFE error, keep the useful code, and
    //    retry only when the error is retryable and attempts remain. The
    //    workflow has already resolved (or deliberately left unresolved) the
    //    attempt marker - the handler never changes submission state.
    const classification = classifySubmissionError(err);
    const safeMessage = safeErrorMessage(err);

    await failRun(run, classification.code, safeMessage);
    await prisma.application
      .updateMany({
        where: { id: application.id, status: { in: ['APPROVED', 'FAILED'] } },
        data: { errorCode: classification.code, errorMessage: safeMessage },
      })
      .catch(() => undefined);
    await auditEvent({
      applicationId: application.id,
      userId: application.userId,
      eventType: 'ERROR',
      message: `Submission job failed: ${classification.code}`,
      metadata: {
        automationRunId: run.id,
        code: classification.code,
        attempt,
        retryable: classification.retryable,
      },
    });

    if (classification.retryable && attempt < SUBMISSION_MAX_ATTEMPTS) {
      // Plain error -> BullMQ schedules the bounded exponential backoff
      // retry. The retry re-enters through the ledger check and can never
      // blindly submit a second time.
      const retryable = new Error(`${classification.code}: ${safeMessage}`);
      retryable.name = 'RetryableSubmissionError';
      throw retryable;
    }
    throw new UnrecoverableError(`${classification.code}: ${safeMessage}`);
  } finally {
    clearInterval(heartbeat);
  }
}
