import { UnrecoverableError } from 'bullmq';
import { prisma } from '@jaa/database';
import type { ApplicationStatus, AutomationRun } from '@prisma/client';
import { preparationJobPayloadSchema, type PreparationJobPayload } from '@jaa/shared';
import { isAtsError, type AtsRegistry } from '@jaa/ats';

import {
  prepareApplication,
  type PrepareApplicationParams,
  type PrepareApplicationResult,
} from '../application-preparation';
import { claimPreparationRun, touchAutomationRun } from './runs';
import { createPreparationRegistry } from './registry';
import { checkPreparationEligibility } from './eligibility';
import {
  OrchestrationError,
  PREPARATION_MAX_ATTEMPTS,
  PREPARABLE_APPLICATION_STATUSES,
  DEFAULT_RUN_STALE_MS,
  safeErrorMessage,
  type OrchestrationErrorCode,
} from './types';

/**
 * Phase 13 - worker job handler (orchestration only).
 *
 * The handler never duplicates preparation logic: it validates the job,
 * claims the AutomationRun with a database-level conditional transition (so
 * two workers can never prepare the same application at once), and delegates
 * to the existing core prepareApplication - which stops at FORM_INSPECTED.
 * It never fills answers, uploads resumes, or submits applications.
 */

export interface ErrorClassification {
  code: OrchestrationErrorCode;
  retryable: boolean;
}

/** ATS errors that are deterministic - retrying cannot help. */
const NON_RETRYABLE_ATS_CODES = new Set([
  'UNSUPPORTED_ATS',
  'ADAPTER_NOT_FOUND',
  'DUPLICATE_PROVIDER',
  'INVALID_APPLICATION_URL',
  'PAGE_NOT_RECOGNIZED',
  'BLOCKED_BY_SECURITY_POLICY',
  // Phase 15A submission boundary: retrying an unknown submission outcome
  // could submit twice, and a refused submission is definitive.
  'SUBMISSION_UNCONFIRMED',
  'SUBMISSION_FAILED',
]);

/** Transient OS/network failures worth retrying. */
const RETRYABLE_SYSCALL_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EBUSY',
  'EMFILE',
  'ENFILE',
]);

/** Transient failure signatures (network, DB reachability, browser startup). */
const RETRYABLE_MESSAGE =
  /(timeout|timed out|temporar|connection (reset|closed|refused|terminated)|can't reach database|stream isn't writeable|target closed|browser.*(closed|crash)|navigation failed|net::|socket hang up|too many clients|connection error|ECONN(REFUSED|RESET|ABORTED)|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)/i;

function hasRetryableSignal(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 3) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; underlying?: unknown };
  if (typeof e.code === 'string' && RETRYABLE_SYSCALL_CODES.has(e.code)) return true;
  if (typeof e.message === 'string' && RETRYABLE_MESSAGE.test(e.message)) return true;
  return hasRetryableSignal(e.cause, depth + 1) || hasRetryableSignal(e.underlying, depth + 1);
}

/**
 * Classify a preparation failure.
 *
 * Retryable (BullMQ may retry with bounded exponential backoff): transient
 * network/provider/Redis/DB/browser-startup failures.
 * Non-retryable (UnrecoverableError - no retry loops around deterministic
 * failures): unsupported ATS, invalid URL, missing application, wrong state,
 * bad payload, security policy challenges.
 */
export function classifyPreparationError(err: unknown): ErrorClassification {
  if (err instanceof OrchestrationError) {
    const retryable =
      err.code === 'PROVIDER_UNAVAILABLE' ||
      err.code === 'TRANSIENT_FAILURE' ||
      err.code === 'ENQUEUE_FAILED';
    return { code: err.code, retryable };
  }

  if (isAtsError(err)) {
    if (err.code === 'PROVIDER_UNAVAILABLE') {
      return { code: 'PROVIDER_UNAVAILABLE', retryable: true };
    }
    if (NON_RETRYABLE_ATS_CODES.has(err.code)) {
      const code =
        err.code === 'PAGE_NOT_RECOGNIZED'
          ? 'PREPARATION_FAILED'
          : err.code === 'SUBMISSION_UNCONFIRMED'
            ? 'SUBMISSION_OUTCOME_UNKNOWN'
            : err.code;
      return { code, retryable: false };
    }
    // INSPECTION_FAILED: retry only when the cause looks transient.
    return hasRetryableSignal(err) || hasRetryableSignal(err.underlying)
      ? { code: 'TRANSIENT_FAILURE', retryable: true }
      : { code: 'PREPARATION_FAILED', retryable: false };
  }

  const message = err instanceof Error ? err.message : String(err);

  // Deterministic guards from the preparation workflow.
  if (message.startsWith('APPLICATION_NOT_FOUND')) {
    return { code: 'APPLICATION_NOT_FOUND', retryable: false };
  }
  if (message.startsWith('INVALID_APPLICATION_STATUS')) {
    return { code: 'APPLICATION_STATE_NOT_PREPARABLE', retryable: false };
  }
  if (message.startsWith('APPLICATION_URL_MISSING')) {
    return { code: 'APPLICATION_URL_MISSING', retryable: false };
  }
  if (message.startsWith('AUTOMATION_RUN_NOT_FOUND')) {
    return { code: 'AUTOMATION_RUN_NOT_FOUND', retryable: false };
  }

  if (hasRetryableSignal(err)) {
    return { code: 'TRANSIENT_FAILURE', retryable: true };
  }
  return { code: 'PREPARATION_FAILED', retryable: false };
}

export interface PreparationJobContext {
  /** 1-based attempt number (BullMQ attemptsMade + 1). */
  attempt?: number;
  registry?: AtsRegistry;
  /** Test/dev only: allow loopback mock ATS servers. */
  allowPrivateUrls?: boolean;
  staleMs?: number;
  heartbeatMs?: number;
  /** Test seam - defaults to the real core prepareApplication. */
  prepare?: (params: PrepareApplicationParams) => Promise<PrepareApplicationResult>;
}

export interface PreparationJobOutcome {
  applicationId: string;
  automationRunId: string;
  outcome: 'COMPLETED' | 'SKIPPED';
  reason?: string;
  status?: ApplicationStatus;
  provider?: string;
  questionsPersisted?: number;
}

async function auditEvent(params: {
  applicationId: string;
  userId: string;
  eventType: 'ERROR' | 'RETRY_STARTED';
  message: string;
  status?: ApplicationStatus;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await prisma.applicationEvent
    .create({
      data: {
        applicationId: params.applicationId,
        userId: params.userId,
        eventType: params.eventType,
        status: params.status,
        message: params.message,
        // IDs, statuses, codes only - never prompts, facts, answers, secrets.
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
 * Process one preparation job. Throws BullMQ's UnrecoverableError for
 * deterministic failures (never retried) and a plain Error for retryable
 * failures (bounded exponential backoff).
 */
export async function handlePreparationJob(
  rawPayload: unknown,
  ctx: PreparationJobContext = {}
): Promise<PreparationJobOutcome> {
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
    // The run belongs to a different application - never mutate it.
    throw new UnrecoverableError('RUN_MISMATCH: job payload does not match the automation run');
  }

  const application = await prisma.application.findUnique({
    where: { id: payload.applicationId },
  });
  if (!application || application.userId !== run.userId) {
    await failRun(run, 'APPLICATION_NOT_FOUND', 'Application not found');
    throw new UnrecoverableError('APPLICATION_NOT_FOUND');
  }

  // 3. Verify the run is still eligible (resume still approved, still
  //    preparable, ATS still supported). Eligibility can change between
  //    enqueue and processing - re-check here, server side.
  try {
    await checkPreparationEligibility({
      applicationId: payload.applicationId,
      userId: run.userId,
      registry: ctx.registry ?? createPreparationRegistry(),
    });
  } catch (err) {
    if (err instanceof OrchestrationError) {
      await failRun(run, err.code, err.message);
      throw new UnrecoverableError(`${err.code}: ${err.message}`);
    }
    throw err;
  }

  // 4. Claim the run: conditional QUEUED/FAILED (or stale RUNNING) -> RUNNING.
  //    The database serializes this transition, so two workers can never
  //    prepare the same application simultaneously.
  const claim = await claimPreparationRun({ runId: run.id, staleMs });
  if (!claim.claimed) {
    return {
      applicationId: payload.applicationId,
      automationRunId: run.id,
      outcome: 'SKIPPED',
      reason: claim.reason,
    };
  }

  // 5. Progress bookkeeping. A re-attempt after a failure is recorded as
  //    RETRY_STARTED and resets the application into PREPARING. Nothing here
  //    (or below) ever advances the application beyond FORM_INSPECTED.
  const isRetry = application.status === 'FAILED';
  await prisma.application.update({
    where: { id: application.id },
    data: {
      lastAttemptAt: new Date(),
      ...(isRetry ? { status: 'PREPARING' as ApplicationStatus } : {}),
    },
  });
  if (isRetry) {
    await auditEvent({
      applicationId: application.id,
      userId: application.userId,
      eventType: 'RETRY_STARTED',
      status: 'PREPARING',
      message: `Retrying application preparation (attempt ${attempt})`,
      metadata: { automationRunId: run.id, attempt },
    });
  }

  // Heartbeat: keep `updatedAt` fresh while the browser works, so a live
  // preparation is never mistaken for a crashed one (small crash-recovery
  // mechanism using only existing fields).
  const heartbeatMs = ctx.heartbeatMs ?? Math.min(60_000, Math.max(1_000, Math.floor(staleMs / 3)));
  const heartbeat = setInterval(() => {
    void touchAutomationRun(run.id);
  }, heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    // 6. Delegate to the existing preparation workflow - never duplicated
    //    here. It resolves the ATS adapter via the registry, drives the
    //    browser through @jaa/browser, persists questions idempotently,
    //    and stops at FORM_INSPECTED.
    const prepare = ctx.prepare ?? prepareApplication;
    const result = await prepare({
      applicationId: application.id,
      registry: ctx.registry ?? createPreparationRegistry(),
      allowPrivateUrls: ctx.allowPrivateUrls,
    });

    // 7. Success: prepareApplication already marked the run COMPLETED; make
    //    sure a custom prepare cannot leave it RUNNING.
    const fresh = await prisma.automationRun.findUnique({ where: { id: run.id } });
    if (fresh && fresh.status === 'RUNNING') {
      await prisma.automationRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          metadata: { provider: result.provider, finalStatus: result.status },
        },
      });
    }

    return {
      applicationId: application.id,
      automationRunId: run.id,
      outcome: 'COMPLETED',
      status: result.status,
      provider: result.provider,
      questionsPersisted: result.questionsPersisted,
    };
  } catch (err) {
    // 8. Failure: classify, persist a SAFE error, keep the useful code, and
    //    retry only when the error is retryable and attempts remain.
    const classification = classifyPreparationError(err);
    const safeMessage = safeErrorMessage(err);

    await failRun(run, classification.code, safeMessage);
    // Mirror prepareApplication's deterministic failure path: an attempt that
    // throws leaves the application FAILED (a later retry resets it to
    // PREPARING). Terminal states are never stomped.
    await prisma.application
      .updateMany({
        where: {
          id: application.id,
          status: { in: [...PREPARABLE_APPLICATION_STATUSES] },
        },
        data: { status: 'FAILED' },
      })
      .catch(() => undefined);
    await auditEvent({
      applicationId: application.id,
      userId: application.userId,
      eventType: 'ERROR',
      message: `Preparation job failed: ${classification.code}`,
      metadata: {
        automationRunId: run.id,
        code: classification.code,
        attempt,
        retryable: classification.retryable,
      },
    });

    if (classification.retryable && attempt < PREPARATION_MAX_ATTEMPTS) {
      // Plain error -> BullMQ schedules the bounded exponential backoff retry.
      const retryable = new Error(`${classification.code}: ${safeMessage}`);
      retryable.name = 'RetryablePreparationError';
      throw retryable;
    }
    if (classification.retryable) {
      // Attempts exhausted - give up without further retries.
      throw new UnrecoverableError(`${classification.code}: ${safeMessage}`);
    }
    throw new UnrecoverableError(`${classification.code}: ${safeMessage}`);
  } finally {
    clearInterval(heartbeat);
  }
}
