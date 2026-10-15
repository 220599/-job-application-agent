import { randomUUID } from 'crypto';
import * as path from 'path';
import { prisma } from '@jaa/database';
import type { ApplicationStatus } from '@jaa/database';
import { Prisma } from '@prisma/client';
import type { Application, AutomationRun, ResumeVersion } from '@prisma/client';
import { launchBrowser } from '@jaa/browser';
import type { JaaBrowserContext } from '@jaa/browser';
import {
  AtsError,
  isAtsError,
  isVerifiedSubmission,
  type AtsFieldFill,
  type AtsFieldLocator,
  type AtsFieldOption,
  type AtsFieldType,
  type AtsRegistry,
  type AtsSubmissionMode,
  type AtsSubmissionResult,
} from '@jaa/ats';

import {
  recordRunCurrentUrl,
  completeAutomationRun,
} from './automation-tracking';
import {
  OrchestrationError,
  TERMINAL_APPLICATION_STATUSES,
  safeErrorMessage,
} from './orchestration/types';
import { assertSubmissionTarget, resolveSubmissionMode } from './submission-policy';
import {
  computeApprovalSnapshot,
  verifyApprovalSnapshot,
  type ApprovalDrift,
  type ApprovalSnapshotInput,
} from './approval-snapshot';

/**
 * Phase 15A/15B - Application submission workflow (packages/core).
 *
 * This is the ONLY place in the system that submits an application. The
 * target policy (submission-policy.ts) decides the mode from the URL alone:
 *
 *   human approval (APPROVED)
 *     -> submission safety gate (resume, answers, target policy)
 *     -> durable submission attempt (SUBMISSION_STARTED marker)
 *     -> real ATS adapter via the registry
 *     -> real browser (@jaa/browser, SSRF-validated) to either
 *        - a LOOPBACK mock ATS (MOCK, Phase 15A), or
 *        - a recognized GREENHOUSE form (REAL, Phase 15B) under the
 *          server's real-submission capability (fail closed, never a
 *          client-controlled choice)
 *     -> verify the provider confirmation (never fabricated)
 *     -> SUBMITTED
 *
 * Safety invariants:
 *  - No submission without an explicit human approval action
 *    (`approveApplicationForSubmission` -> status APPROVED). Approval is
 *    never inferred from resume approval, preparation, matching, filled
 *    forms, or AI confidence.
 *  - CAPTCHA / MFA / security challenges STOP the submission. They are
 *    never solved and never bypassed.
 *  - MOCK envelopes carry identifiers and counts only - never answers,
 *    resume content, credentials, or candidate PII. REAL fills use the
 *    prepared answers in memory (never in queue payloads or events) and
 *    send them only to the Greenhouse form itself.
 *  - The target policy is enforced here as well as in the gate (defense in
 *    depth): mock stays loopback-only, real requires the server capability,
 *    a recognized Greenhouse URL, and the public-URL (SSRF) policy.
 *
 * Crash safety (the dangerous boundary):
 *    "the external submit succeeded, but the database completion update
 *     never happened, and the worker retries"
 *  is protected by a durable attempt ledger built from ApplicationEvent
 *  rows (no schema change needed):
 *
 *  - BEFORE the external request, one transaction writes
 *      SUBMISSION_STARTED (metadata.submissionAttemptId) + status SUBMITTING
 *    so "SUBMITTING" and "an unresolved attempt marker" always appear
 *    together (they are written atomically).
 *  - AFTER the outcome is known, one transaction writes the resolution
 *      SUBMISSION_COMPLETED (SUBMITTED) or SUBMISSION_FAILED (definitively
 *    not submitted) together with the final status.
 *  - A later attempt that finds an UNRESOLVED marker can no longer know
 *    whether the previous worker submitted before dying (or whether a
 *    request that failed in transit actually reached the ATS). It therefore
 *    NEVER submits blindly again: it records the unknown outcome
 *    (SUBMISSION_OUTCOME_UNKNOWN) and stops terminally.
 *
 * Limitation (documented honestly): true external exactly-once semantics
 * cannot be guaranteed through the current ATS interface - a request that
 * fails in transit may or may not have been accepted by the far side. The
 * strongest safe mechanism available is implemented instead: at-most-one
 * external submission attempt per unresolved marker, and permanent refusal
 * to re-submit while an attempt's outcome is unknown.
 */

// ---------------------------------------------------------------------------
// TEST-ONLY crash simulation
// ---------------------------------------------------------------------------

/**
 * TEST-ONLY: thrown by the `afterExternalSubmit` hook to simulate a worker
 * process dying AFTER the external submission request completed but BEFORE
 * any database bookkeeping. The workflow and the job handler rethrow it with
 * ZERO bookkeeping - exactly like a real crash at that boundary.
 */
export class SimulatedWorkerCrash extends Error {
  readonly code = 'SIMULATED_WORKER_CRASH';
  constructor(message = 'Simulated worker crash after external submit') {
    super(message);
    this.name = 'SimulatedWorkerCrash';
  }
}

export function isSimulatedWorkerCrash(err: unknown): err is SimulatedWorkerCrash {
  return err instanceof SimulatedWorkerCrash;
}

// ---------------------------------------------------------------------------
// Submission attempt ledger (ApplicationEvent based - no schema change)
// ---------------------------------------------------------------------------

const LEDGER_EVENT_TYPES = [
  'SUBMISSION_STARTED',
  'SUBMISSION_COMPLETED',
  'SUBMISSION_FAILED',
] as const;

function attemptIdOf(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object') {
    const id = (metadata as Record<string, unknown>)['submissionAttemptId'];
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * The latest submission attempt whose outcome is UNKNOWN (started but never
 * resolved). While one exists, no new submission attempt may ever start.
 */
export async function findUnresolvedSubmissionAttempt(
  applicationId: string
): Promise<string | null> {
  const events = await prisma.applicationEvent.findMany({
    where: { applicationId, eventType: { in: [...LEDGER_EVENT_TYPES] } },
    select: { eventType: true, metadata: true },
    orderBy: { createdAt: 'asc' },
  });
  const started = new Set<string>();
  const resolved = new Set<string>();
  for (const event of events) {
    const attemptId = attemptIdOf(event.metadata);
    if (!attemptId) continue;
    if (event.eventType === 'SUBMISSION_STARTED') started.add(attemptId);
    else resolved.add(attemptId);
  }
  for (const attemptId of started) {
    if (!resolved.has(attemptId)) return attemptId;
  }
  return null;
}

/**
 * Batch form of {@link findUnresolvedSubmissionAttempt}: applicationId ->
 * unresolved attemptId, for every application that has one.
 */
export async function findUnresolvedSubmissionAttempts(
  applicationIds: string[]
): Promise<Map<string, string>> {
  const unresolved = new Map<string, string>();
  if (applicationIds.length === 0) return unresolved;
  const events = await prisma.applicationEvent.findMany({
    where: {
      applicationId: { in: applicationIds },
      eventType: { in: [...LEDGER_EVENT_TYPES] },
    },
    select: { applicationId: true, eventType: true, metadata: true },
    orderBy: { createdAt: 'asc' },
  });
  const started = new Map<string, Set<string>>();
  const resolved = new Map<string, Set<string>>();
  for (const event of events) {
    const attemptId = attemptIdOf(event.metadata);
    if (!attemptId) continue;
    const target = event.eventType === 'SUBMISSION_STARTED' ? started : resolved;
    const set = target.get(event.applicationId) ?? new Set<string>();
    set.add(attemptId);
    target.set(event.applicationId, set);
  }
  for (const [applicationId, attempts] of started) {
    const done = resolved.get(applicationId) ?? new Set<string>();
    for (const attemptId of attempts) {
      if (!done.has(attemptId)) {
        unresolved.set(applicationId, attemptId);
        break;
      }
    }
  }
  return unresolved;
}

/** True when at least one submission attempt has ever been started. */
export async function hasSubmissionAttemptHistory(applicationId: string): Promise<boolean> {
  const count = await prisma.applicationEvent.count({
    where: { applicationId, eventType: 'SUBMISSION_STARTED' },
  });
  return count > 0;
}

// ---------------------------------------------------------------------------
// Approval snapshot binding (Phase 15D - approval integrity)
// ---------------------------------------------------------------------------

type DbClient = typeof prisma | Prisma.TransactionClient;

/**
 * Load the bindable content of an application (target, resume version,
 * questions + answers) for snapshot computation. Only identifiers and hashes
 * ever leave this function - never answer or resume text.
 */
async function loadApprovalSnapshotInput(
  client: DbClient,
  application: Pick<Application, 'id' | 'jobId' | 'applicationUrl'> & {
    resumeVersion?: ResumeVersion | null;
  }
): Promise<ApprovalSnapshotInput> {
  const resumeVersion = application.resumeVersion ?? null;
  const questions = await client.applicationQuestion.findMany({
    where: { applicationId: application.id },
    select: {
      id: true,
      label: true,
      required: true,
      fieldType: true,
      externalFieldId: true,
      options: true,
      locator: true,
      answer: { select: { answer: true } },
    },
    orderBy: { id: 'asc' },
  });
  return {
    jobId: application.jobId,
    applicationUrl: application.applicationUrl,
    resumeVersion: resumeVersion
      ? {
          id: resumeVersion.id,
          filePath: resumeVersion.filePath,
          extractedText: resumeVersion.extractedText,
          tailoring: resumeVersion.tailoring,
          parsedData: resumeVersion.parsedData,
        }
      : null,
    questions,
  };
}

/**
 * Invalidate an approval that no longer covers the current application
 * content. The application returns to READY_FOR_REVIEW: a NEW explicit
 * approval is always required before anything can be submitted. Approved
 * content is never submitted from a stale approval, and a changed application
 * is never silently submitted under an old approval.
 */
export async function invalidateApproval(params: {
  application: Pick<Application, 'id' | 'userId'>;
  code: 'APPROVAL_STALE' | 'APPROVAL_NOT_VERIFIED';
  drift?: ApprovalDrift[];
}): Promise<void> {
  const message =
    params.code === 'APPROVAL_NOT_VERIFIED'
      ? 'The approval could not be verified against the current application content; a new explicit approval is required'
      : 'The application content changed after approval; a new explicit approval is required';
  const updated = await prisma.application.updateMany({
    where: {
      id: params.application.id,
      status: { in: ['APPROVED', 'FAILED'] },
    },
    data: {
      status: 'READY_FOR_REVIEW',
      errorCode: params.code,
      errorMessage: message,
      approvedAt: null,
      approvalSnapshot: Prisma.DbNull,
    },
  });
  if (updated.count === 0) return;
  await prisma.applicationEvent.create({
    data: {
      applicationId: params.application.id,
      userId: params.application.userId,
      eventType: 'REVIEW_REQUESTED',
      status: 'READY_FOR_REVIEW',
      message,
      // Component names only - never question text, answers, or resume text.
      metadata: { code: params.code, drift: params.drift ?? [] },
    },
  });
}

/**
 * Early approval-integrity verification (API request path): the current
 * application content must still EXACTLY match the approved snapshot. On
 * drift (or an unverifiable approval) the approval is invalidated - the
 * application returns to READY_FOR_REVIEW - and the caller must re-approve.
 * The attempt claim re-verifies this transactionally (defense in depth).
 */
export async function verifyApprovalForSubmission(
  application: Application & { resumeVersion: ResumeVersion | null }
): Promise<void> {
  const snapshot = computeApprovalSnapshot(
    await loadApprovalSnapshotInput(prisma, application)
  );
  const verdict = verifyApprovalSnapshot(application.approvalSnapshot, snapshot);
  if (verdict.ok) return;
  const code =
    verdict.reason === 'STALE' ? 'APPROVAL_STALE' : 'APPROVAL_NOT_VERIFIED';
  await invalidateApproval({ application, code, drift: verdict.drift });
  throw new OrchestrationError(
    code,
    code === 'APPROVAL_NOT_VERIFIED'
      ? 'The approval could not be verified for the current application content; a new explicit approval is required before submission'
      : 'The application content changed after approval; a new explicit approval is required before submission'
  );
}

// ---------------------------------------------------------------------------
// Explicit human approval (the ONLY way an application becomes submittable)
// ---------------------------------------------------------------------------

export interface ApproveApplicationParams {
  applicationId: string;
  userId: string;
}

export interface ApproveApplicationResult {
  applicationId: string;
  status: ApplicationStatus;
  /** True when the application was already approved (idempotent no-op). */
  alreadyApproved: boolean;
  /**
   * True when this call re-bound the approval to changed content (a fresh
   * approval of the CURRENT application snapshot).
   */
  reapproved?: boolean;
}

/**
 * The explicit human approval action. This - and nothing else - moves an
 * application into the submittable APPROVED state. Resume approval,
 * completed preparation, job matching, form filling, and AI confidence can
 * NEVER imply approval for submission.
 */
export async function approveApplicationForSubmission(
  params: ApproveApplicationParams
): Promise<ApproveApplicationResult> {
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { resumeVersion: true },
  });
  if (!application || application.userId !== params.userId) {
    throw new OrchestrationError('APPLICATION_NOT_FOUND', 'Application not found');
  }
  if (TERMINAL_APPLICATION_STATUSES.includes(application.status)) {
    throw new OrchestrationError(
      'APPLICATION_TERMINAL',
      `Application is in terminal status ${application.status} and cannot be approved`
    );
  }

  // The approval binds the EXACT content being approved: target, resume
  // version (identity + content), and every question + answer.
  const snapshotInput = await loadApprovalSnapshotInput(prisma, application);
  const snapshot = computeApprovalSnapshot(snapshotInput);

  if (application.status === 'APPROVED') {
    const verdict = verifyApprovalSnapshot(application.approvalSnapshot, snapshot);
    if (verdict.ok) {
      // Idempotent no-op: nothing changed since the approval.
      return { applicationId: application.id, status: 'APPROVED', alreadyApproved: true };
    }
    // The content drifted (or this row's approval was never bound): this
    // fresh approval action covers the CURRENT content - re-bind it.
    await prisma.$transaction([
      prisma.application.update({
        where: { id: application.id },
        data: { approvedAt: new Date(), approvalSnapshot: snapshot as object },
      }),
      prisma.applicationEvent.create({
        data: {
          applicationId: application.id,
          userId: application.userId,
          eventType: 'REVIEW_APPROVED',
          status: 'APPROVED',
          message: 'Human re-approved the application after its content changed',
          metadata: {
            priorStatus: application.status,
            reapproved: true,
            // Component names only - never content.
            drift: verdict.reason === 'STALE' ? verdict.drift : [],
            contentHash: snapshot.contentHash,
          },
        },
      }),
    ]);
    return {
      applicationId: application.id,
      status: 'APPROVED',
      alreadyApproved: false,
      reapproved: true,
    };
  }
  if (application.status !== 'FORM_INSPECTED' && application.status !== 'READY_FOR_REVIEW') {
    throw new OrchestrationError(
      'APPLICATION_STATE_NOT_SUBMITTABLE',
      `Application status ${application.status} cannot be approved for submission`
    );
  }

  await prisma.$transaction([
    prisma.application.update({
      where: { id: application.id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        approvalSnapshot: snapshot as object,
      },
    }),
    prisma.applicationEvent.create({
      data: {
        applicationId: application.id,
        userId: application.userId,
        eventType: 'REVIEW_APPROVED',
        status: 'APPROVED',
        message: 'Human approved the application for submission',
        metadata: {
          priorStatus: application.status,
          contentHash: snapshot.contentHash,
        },
      },
    }),
  ]);

  return { applicationId: application.id, status: 'APPROVED', alreadyApproved: false };
}

// ---------------------------------------------------------------------------
// Submission workflow
// ---------------------------------------------------------------------------

export interface SubmitApplicationParams {
  applicationId: string;
  userId: string;
  registry: AtsRegistry;
  headless?: boolean;
  /** Test/dev only: allows loopback mock ATS servers. Default false. */
  allowPrivateUrls?: boolean;
  /** 1-based attempt number (BullMQ attemptsMade + 1) for audit metadata. */
  attempt?: number;
  /**
   * TEST-ONLY crash simulation: invoked immediately after the external
   * submission request completed and BEFORE any database bookkeeping. An
   * error thrown from it (use {@link SimulatedWorkerCrash}) propagates with
   * zero bookkeeping - exactly like a worker process dying at that
   * boundary.
   */
  afterExternalSubmit?: () => void | Promise<void>;
}

export type SubmitApplicationResult =
  | {
      outcome: 'SUBMITTED';
      applicationId: string;
      status: ApplicationStatus;
      provider: string;
      submissionAttemptId: string;
      /** Provider confirmation reference; null when none was exposed. */
      externalApplicationId: string | null;
      automationRunId: string;
    }
  | {
      outcome: 'SKIPPED';
      applicationId: string;
      reason: 'ALREADY_SUBMITTED' | 'NOT_CLAIMABLE';
      automationRunId?: string;
    };

type SubmissionFailureExtraEvent = {
  eventType: 'CAPTCHA_DETECTED' | 'SECURITY_CHALLENGE';
  message: string;
  metadata: Record<string, unknown>;
};

/**
 * One attempt = one durable marker + one external request maximum.
 * Returns claimed=false when the state machine forbids a new attempt here.
 */
async function claimSubmissionAttempt(params: {
  application: Application;
  submissionAttemptId: string;
  attempt: number;
  provider: string;
}): Promise<{
  claimed: boolean;
  reason?: 'ALREADY_SUBMITTED' | 'NOT_CLAIMABLE' | 'APPROVAL_NOT_VERIFIED' | 'APPROVAL_STALE';
  drift?: ApprovalDrift[];
  /** The snapshot-verified content to submit - exactly what was approved. */
  verifiedContent?: ApprovalSnapshotInput;
}> {
  const { application, submissionAttemptId, attempt, provider } = params;
  return prisma.$transaction(async (tx) => {
    const current = await tx.application.findUnique({
      where: { id: application.id },
      include: { resumeVersion: true },
    });
    if (!current) return { claimed: false, reason: 'NOT_CLAIMABLE' as const };
    if (current.status === 'SUBMITTED') {
      return { claimed: false, reason: 'ALREADY_SUBMITTED' as const };
    }

    // Approval integrity (Phase 15D): the request that is about to be sent
    // must be EXACTLY what the human approved. The snapshot fingerprint is
    // recomputed from the current rows inside this transaction - a resume
    // swap, an answer edit, a target change, or an approval flag set without
    // the server-side approval action all refuse the claim here (fail
    // closed), before any state change and long before any request. The
    // verified content is handed to the caller so the submission itself uses
    // exactly this snapshot - never anything newer.
    const verifiedContent = await loadApprovalSnapshotInput(tx, current);
    const currentSnapshot = computeApprovalSnapshot(verifiedContent);
    const verdict = verifyApprovalSnapshot(current.approvalSnapshot, currentSnapshot);
    if (!verdict.ok) {
      return {
        claimed: false,
        reason: verdict.reason === 'STALE' ? 'APPROVAL_STALE' : 'APPROVAL_NOT_VERIFIED',
        drift: verdict.drift,
      };
    }

    // Fresh attempts require the explicit human approval state. Retries may
    // continue an approved submission from FAILED - but only when submission
    // attempt history proves this is a retry of THIS submission (a FAILED
    // application with no attempt history is a failed preparation, which is
    // never submittable).
    const isRetry = current.status !== 'APPROVED';
    if (isRetry) {
      if (current.status !== 'FAILED') {
        return { claimed: false, reason: 'NOT_CLAIMABLE' as const };
      }
      const started = await tx.applicationEvent.count({
        where: { applicationId: application.id, eventType: 'SUBMISSION_STARTED' },
      });
      if (started === 0) return { claimed: false, reason: 'NOT_CLAIMABLE' as const };
    }

    // Atomic state transition: exactly one concurrent attempt can win it.
    const updated = await tx.application.updateMany({
      where: { id: application.id, status: current.status },
      data: {
        status: 'SUBMITTING',
        lastAttemptAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
    if (updated.count !== 1) return { claimed: false, reason: 'NOT_CLAIMABLE' as const };

    if (isRetry) {
      await tx.applicationEvent.create({
        data: {
          applicationId: application.id,
          userId: application.userId,
          eventType: 'RETRY_STARTED',
          status: 'SUBMITTING',
          message: `Retrying application submission (attempt ${attempt})`,
          metadata: { submissionAttemptId, attempt },
        },
      });
    }
    // The durable attempt marker. Written in the SAME transaction as the
    // SUBMITTING transition, so "SUBMITTING" always implies "a marker
    // exists" and a crash can never leave one without the other.
    await tx.applicationEvent.create({
      data: {
        applicationId: application.id,
        userId: application.userId,
        eventType: 'SUBMISSION_STARTED',
        status: 'SUBMITTING',
        message: `Submission attempt started via ${provider}`,
        metadata: { submissionAttemptId, attempt, provider },
      },
    });
    return { claimed: true, verifiedContent };
  });
}

/**
 * Resolve an attempt as DEFINITIVELY NOT SUBMITTED (the ATS answered and
 * refused, the request was never sent, or a challenge stopped it). One
 * transaction: final status + SUBMISSION_FAILED (which resolves the marker).
 */
async function resolveSubmissionFailure(params: {
  application: Application;
  submissionAttemptId: string;
  code: string;
  message: string;
  httpStatus?: number | null;
  retryable?: boolean;
  /** PII-safe diagnostic strings from the adapter (field names/codes only). */
  warnings?: string[];
  extraEvents?: SubmissionFailureExtraEvent[];
}): Promise<void> {
  const { application, submissionAttemptId, code, message } = params;
  const safeMessage = safeErrorMessage(message);
  const safeWarnings = (params.warnings ?? []).slice(0, 10).map((w) => safeErrorMessage(w));
  await prisma.$transaction([
    prisma.application.update({
      where: { id: application.id },
      data: { status: 'FAILED', errorCode: code, errorMessage: safeMessage },
    }),
    ...(params.extraEvents ?? []).map((event) =>
      prisma.applicationEvent.create({
        data: {
          applicationId: application.id,
          userId: application.userId,
          eventType: event.eventType,
          status: 'FAILED',
          message: event.message,
          // IDs, codes and challenge kinds only - never page content.
          metadata: { submissionAttemptId, ...event.metadata },
        },
      })
    ),
    prisma.applicationEvent.create({
      data: {
        applicationId: application.id,
        userId: application.userId,
        eventType: 'SUBMISSION_FAILED',
        status: 'FAILED',
        message: safeMessage,
        metadata: {
          submissionAttemptId,
          code,
          ...(params.httpStatus != null ? { httpStatus: params.httpStatus } : {}),
          ...(params.retryable != null ? { retryable: params.retryable } : {}),
          ...(safeWarnings.length > 0 ? { warnings: safeWarnings } : {}),
        },
      },
    }),
  ]);
}

/**
 * Record an UNKNOWN submission outcome: the attempt marker is deliberately
 * left UNRESOLVED (the outcome genuinely is unknown), and no later attempt
 * may ever submit blindly again for this application.
 */
export async function recordUnknownSubmissionOutcome(params: {
  application: Application;
  reason: string;
  /** PII-safe diagnostic strings from the adapter (field names/codes only). */
  warnings?: string[];
}): Promise<void> {
  const safeMessage = safeErrorMessage(params.reason);
  const safeWarnings = (params.warnings ?? []).slice(0, 10).map((w) => safeErrorMessage(w));
  await prisma.$transaction([
    prisma.application.update({
      where: { id: params.application.id },
      data: {
        status: 'FAILED',
        errorCode: 'SUBMISSION_OUTCOME_UNKNOWN',
        errorMessage: safeMessage,
      },
    }),
    // The attempt marker stays deliberately UNRESOLVED (the outcome is
    // genuinely unknown); this event records the observation only.
    prisma.applicationEvent.create({
      data: {
        applicationId: params.application.id,
        userId: params.application.userId,
        eventType: 'ERROR',
        status: 'FAILED',
        message: 'Submission outcome unknown: no new submission is ever attempted',
        metadata: {
          code: 'SUBMISSION_OUTCOME_UNKNOWN',
          ...(safeWarnings.length > 0 ? { warnings: safeWarnings } : {}),
        },
      },
    }),
  ]);
}

/**
 * Attempt one mock application submission. Throws a typed
 * {@link OrchestrationError} after doing its bookkeeping on every failure
 * path; returns only when the submission is verified as SUBMITTED (or when
 * the attempt was skipped as already submitted / not claimable).
 */
export async function submitApplication(
  params: SubmitApplicationParams
): Promise<SubmitApplicationResult> {
  const attempt = params.attempt ?? 1;

  const application = (await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { resumeVersion: true, job: true },
  })) as (Application & { resumeVersion: ResumeVersion | null }) | null;
  if (!application || application.userId !== params.userId) {
    throw new OrchestrationError('APPLICATION_NOT_FOUND', 'Application not found');
  }

  const run = await prisma.automationRun.findUnique({
    where: { applicationId: application.id },
  });

  // 1. Crash-safety ledger: an unresolved attempt means a previous worker
  //    may have submitted without recording it. NEVER blindly submit again.
  const unresolvedAttemptId = await findUnresolvedSubmissionAttempt(application.id);
  if (unresolvedAttemptId) {
    await recordUnknownSubmissionOutcome({
      application,
      reason:
        'A previous submission attempt has no recorded outcome; the application may or may not have been submitted, so no new submission is attempted',
    });
    throw new OrchestrationError(
      'SUBMISSION_OUTCOME_UNKNOWN',
      'A previous submission attempt has an unknown outcome; submission is stopped and requires human resolution'
    );
  }

  // 2. Claim exactly one durable submission attempt (atomic transition).
  const submissionAttemptId = randomUUID();
  const adapter = params.registry.findForUrl(application.applicationUrl ?? '');
  const provider = adapter?.provider ?? 'UNKNOWN';

  // Defense in depth: enforce the target policy HERE too, before any
  // bookkeeping. MOCK stays loopback + opt-in; REAL requires the server
  // capability, a recognized Greenhouse URL, and SSRF-safe URLs. Fail
  // closed with nothing written when the policy refuses.
  if (application.applicationUrl) {
    assertSubmissionTarget(application.applicationUrl, adapter?.provider ?? null);
  }

  const claim = await claimSubmissionAttempt({
    application,
    submissionAttemptId,
    attempt,
    provider,
  });
  if (!claim.claimed) {
    if (claim.reason === 'APPROVAL_STALE' || claim.reason === 'APPROVAL_NOT_VERIFIED') {
      // The approval no longer covers what would be submitted. Invalidate it
      // (the application returns to "awaiting approval") and stop - nothing
      // is ever submitted from a stale or unverified approval.
      await invalidateApproval({
        application,
        code: claim.reason,
        drift: claim.drift,
      });
      throw new OrchestrationError(
        claim.reason,
        claim.reason === 'APPROVAL_NOT_VERIFIED'
          ? 'The approval could not be verified for the current application content; a new explicit approval is required before submission'
          : 'The application content changed after approval; a new explicit approval is required before submission'
      );
    }
    return {
      outcome: 'SKIPPED',
      applicationId: application.id,
      reason: claim.reason ?? 'NOT_CLAIMABLE',
      ...(run ? { automationRunId: run.id } : {}),
    };
  }

  if (!adapter || !application.applicationUrl) {
    await resolveSubmissionFailure({
      application,
      submissionAttemptId,
      code: 'UNSUPPORTED_ATS',
      message: 'No ATS adapter can handle this application URL',
      retryable: false,
    });
    throw new OrchestrationError(
      'UNSUPPORTED_ATS',
      'No ATS adapter can handle this application URL'
    );
  }

  const applicationUrl = application.applicationUrl;

  // 3. Build the submission content from the SNAPSHOT-VERIFIED data returned
  //    by the claim transaction: exactly what the human approved, never
  //    anything newer (a concurrent edit cannot change what is sent). Only
  //    counts enter the MOCK envelope - never content.
  const verifiedContent = claim.verifiedContent!;
  const questions = verifiedContent.questions;
  const fieldCount = questions.length;
  const requiredAnswerCount = questions.filter((question) => question.required).length;

  // Mode is decided by the server from the URL alone (never by a client).
  // The prepared values are kept in memory so the adapter can fill the form
  // or validate against a documented submission API in any mode - they never
  // enter the MOCK envelope (identifiers + counts only), queue payloads, or
  // event metadata.
  const submissionMode: AtsSubmissionMode = applicationUrl
    ? resolveSubmissionMode(applicationUrl)
    : 'MOCK';
  const fieldFills: AtsFieldFill[] = questions.flatMap((question) => {
    const value = question.answer?.answer ?? '';
    if (value.trim().length === 0) return [];
    return [
      {
        questionId: question.id,
        fieldType: question.fieldType as AtsFieldType,
        locator: (question.locator as AtsFieldLocator | null) ?? null,
        value,
        required: question.required,
        options: (question.options as AtsFieldOption[] | null) ?? null,
        // Form question identity: providers with a documented non-browser
        // submission API map answers onto its documented field names from
        // these (never by guessing).
        label: question.label,
        externalFieldId: question.externalFieldId,
      },
    ];
  });
  const resumePath = verifiedContent.resumeVersion?.filePath ?? null;
  const resumeFile: string | null = resumePath
    ? path.isAbsolute(resumePath)
      ? resumePath
      : path.resolve(resumePath)
    : null;

  let browserContext: JaaBrowserContext | null = null;
  try {
    if (run) await recordRunCurrentUrl(run.id, applicationUrl);

    const browser = await launchBrowser({
      headless: params.headless,
      allowPrivateUrls: params.allowPrivateUrls,
    });
    browserContext = await browser.createContext({ allowPrivateUrls: params.allowPrivateUrls });
    const page = await browserContext.createPage();

    // 4. The submission boundary: real adapter -> real browser -> either
    //    the local mock ATS (MOCK envelope: identifiers + counts only) or
    //    the live Greenhouse form (REAL fill from in-memory prepared values).
    let result: AtsSubmissionResult;
    try {
      result = await adapter.submitApplication({
        url: applicationUrl,
        page,
        browserContext,
        applicationId: application.id,
        userId: application.userId,
        jobId: application.jobId,
        submissionAttemptId,
        fieldCount,
        requiredAnswerCount,
        submissionMode,
        fieldFills,
        resumeFile,
        metadata: { provider },
      });
    } catch (err) {
      if (isAtsError(err) && err.code === 'SUBMISSION_UNCONFIRMED') {
        // The request may or may not have reached the ATS. Unknown outcome:
        // resolve NOTHING, never retry blindly.
        await recordUnknownSubmissionOutcome({
          application,
          reason: err.message,
        });
        throw new OrchestrationError(
          'SUBMISSION_OUTCOME_UNKNOWN',
          safeErrorMessage(err.message)
        );
      }
      // Thrown before/without the request going out: definitively not
      // submitted, so the marker is resolved and a bounded retry is safe.
      // A typed SUBMISSION_FAILED is a definitive refusal (credentials,
      // validation, fill) and is never auto-retried - the metadata matches
      // the handler's classification; other thrown errors keep the bounded
      // retryable path.
      const code = isAtsError(err) ? err.code : 'SUBMISSION_FAILED';
      await resolveSubmissionFailure({
        application,
        submissionAttemptId,
        code,
        message: err instanceof Error ? err.message : String(err),
        retryable: !(isAtsError(err) && err.code === 'SUBMISSION_FAILED'),
      });
      throw err;
    }

    // TEST-ONLY crash point: a real worker death here leaves the marker
    // unresolved and the application SUBMITTING - exactly what the retry
    // must detect and refuse to blindly re-submit.
    if (params.afterExternalSubmit) {
      await params.afterExternalSubmit();
    }

    if (run) await recordRunCurrentUrl(run.id, result.url || applicationUrl).catch(() => undefined);

    // 5. Verify the result before any SUBMITTED bookkeeping. Verification
    //    only accepts real provider evidence (confirmation id or confirmed
    //    success page) - nothing is ever fabricated.
    if (result.outcome === 'SUBMITTED' && isVerifiedSubmission(result)) {
      const confirmation = result.confirmation ?? null;
      const providerReference =
        typeof result.externalApplicationId === 'string' &&
        result.externalApplicationId.trim().length > 0
          ? result.externalApplicationId.trim()
          : (confirmation?.reference?.trim() || null);
      const safeResultWarnings = (result.warnings ?? [])
        .slice(0, 10)
        .map((warning) => safeErrorMessage(warning));
      await prisma.$transaction([
        prisma.application.update({
          where: { id: application.id },
          data: {
            status: 'SUBMITTED',
            submittedAt: new Date(),
            externalApplicationId: providerReference,
            errorCode: null,
            errorMessage: null,
          },
        }),
        prisma.applicationEvent.create({
          data: {
            applicationId: application.id,
            userId: application.userId,
            eventType: 'SUBMISSION_COMPLETED',
            status: 'SUBMITTED',
            message: 'Application submitted and confirmation verified',
            metadata: {
              submissionAttemptId,
              provider,
              confirmationId: providerReference,
              // IDs, codes and URLs only - never answers or page content.
              ...(confirmation ? { confirmationMethod: confirmation.method } : {}),
              ...(confirmation?.url
                ? { confirmationUrl: safeErrorMessage(confirmation.url) }
                : {}),
              url: safeErrorMessage(result.url || applicationUrl),
              ...(result.httpStatus != null ? { httpStatus: result.httpStatus } : {}),
              // Which transport carried the request (API vs browser) and
              // PII-free adapter diagnostics - so a policy-permitted path
              // choice is always auditable, never silent.
              ...(result.transport ? { transport: result.transport } : {}),
              ...(safeResultWarnings.length > 0 ? { warnings: safeResultWarnings } : {}),
            },
          },
        }),
      ]);
      if (run) {
        await completeAutomationRun(run.id, {
          status: 'COMPLETED',
          metadata: {
            provider,
            finalStatus: 'SUBMITTED',
            submissionAttemptId,
            lastUrl: safeErrorMessage(result.url || applicationUrl),
          },
        }).catch(() => undefined);
      }
      return {
        outcome: 'SUBMITTED',
        applicationId: application.id,
        status: 'SUBMITTED',
        provider,
        submissionAttemptId,
        externalApplicationId: providerReference,
        automationRunId: run?.id ?? '',
      };
    }

    if (result.outcome === 'CHALLENGE_DETECTED') {
      const kind = result.challenge?.kind ?? 'SECURITY_CHALLENGE';
      const eventType: SubmissionFailureExtraEvent['eventType'] =
        kind === 'CAPTCHA' ? 'CAPTCHA_DETECTED' : 'SECURITY_CHALLENGE';
      await resolveSubmissionFailure({
        application,
        submissionAttemptId,
        code: eventType,
        message: `Submission stopped: a ${kind} challenge was detected and is never solved or bypassed`,
        retryable: false,
        warnings: result.warnings,
        extraEvents: [
          {
            eventType,
            message: `A ${kind} challenge (${result.challenge?.detail ?? 'unknown'}) stopped the submission; it is never solved or bypassed`,
            metadata: { challengeKind: kind, challengeDetail: result.challenge?.detail ?? null },
          },
        ],
      });
      throw new OrchestrationError(
        eventType,
        'Submission stopped: a security challenge was detected and is never solved or bypassed'
      );
    }

    if (result.outcome === 'SUBMITTED') {
      // "Submitted" without a verifiable confirmation is an UNKNOWN outcome.
      await recordUnknownSubmissionOutcome({
        application,
        reason: 'The ATS reported success without a verifiable confirmation',
        warnings: result.warnings,
      });
      throw new OrchestrationError(
        'SUBMISSION_OUTCOME_UNKNOWN',
        'The ATS reported success without a verifiable confirmation'
      );
    }

    // REJECTED: the ATS answered and refused - definitively not submitted.
    const httpStatus = result.httpStatus ?? null;
    const retryable = httpStatus != null && httpStatus >= 500;
    await resolveSubmissionFailure({
      application,
      submissionAttemptId,
      code: 'SUBMISSION_FAILED',
      message: `The ATS rejected the submission request${httpStatus != null ? ` (HTTP ${httpStatus})` : ''}`,
      httpStatus,
      retryable,
      warnings: result.warnings,
    });
    if (retryable) {
      throw new OrchestrationError(
        'TRANSIENT_FAILURE',
        `The ATS rejected the submission request (HTTP ${httpStatus})`
      );
    }
    throw new OrchestrationError(
      'SUBMISSION_FAILED',
      `The ATS rejected the submission request${httpStatus != null ? ` (HTTP ${httpStatus})` : ''}`
    );
  } finally {
    if (browserContext) {
      await browserContext.close().catch(() => undefined);
    }
  }
}
