import { prisma } from '@jaa/database';
import type { AutomationRun } from '@prisma/client';
import type { PreparationJobPayload } from '@jaa/shared';

import { checkSubmissionEligibility } from './submission-eligibility';
import { enqueueSubmissionJob } from './submission-queue';
import {
  OrchestrationError,
  DEFAULT_RUN_STALE_MS,
  safeAutomationRunView,
  type SafeAutomationRunView,
} from './types';

/**
 * Phase 15A - AutomationRun lifecycle for queued mock submissions.
 *
 * Mirrors the Phase 13 preparation run lifecycle exactly (same system, same
 * primitives): PostgreSQL is the durable source of truth, BullMQ is only the
 * execution mechanism, and the payload is identifiers only.
 *
 * Idempotency is enforced in PostgreSQL, not in memory:
 *   - `AutomationRun.applicationId` is @unique, so there is at most ONE run
 *     row per application, ever (concurrent creates collapse via P2002);
 *   - enqueueing happens only after a CONDITIONAL state transition
 *     (updateMany with a status predicate) wins the race - losing requests
 *     return the existing run and enqueue nothing;
 *   - the submission safety gate refuses everything that is not explicitly
 *     human-approved, already submitted, or left with an unknown outcome.
 * A single BullMQ submission job is therefore never duplicated, and no
 * application is ever submitted twice.
 */

export type EnqueueSubmissionFn = (payload: PreparationJobPayload) => Promise<void>;

export interface RequestSubmissionParams {
  applicationId: string;
  userId: string;
  /** Staleness threshold for crashed-run recovery. */
  staleMs?: number;
  /** Test seam: replace the real BullMQ enqueue. */
  enqueue?: EnqueueSubmissionFn;
}

export interface RequestSubmissionResult {
  /** The safe run view; null only for an already-submitted application with no run row. */
  automationRun: SafeAutomationRunView | null;
  /** True when the application was already submitted (idempotent no-op). */
  alreadySubmitted: boolean;
  /** True when an already-active run was returned as-is (idempotent). */
  reused: boolean;
  /** True when THIS call queued a new BullMQ job. */
  enqueued: boolean;
}

async function findRun(applicationId: string): Promise<AutomationRun | null> {
  return prisma.automationRun.findUnique({ where: { applicationId } });
}

/**
 * Queue a mock application submission. Already-submitted applications are a
 * no-op success (nothing is enqueued, nothing is submitted again); an
 * already-active run is returned as-is; otherwise the run is atomically
 * claimed and exactly one job is enqueued.
 */
export async function requestApplicationSubmission(
  params: RequestSubmissionParams
): Promise<RequestSubmissionResult> {
  // Idempotent no-op BEFORE anything else: a submitted application never
  // produces another submission job.
  const existingApplication = await prisma.application.findUnique({
    where: { id: params.applicationId },
  });
  if (!existingApplication || existingApplication.userId !== params.userId) {
    throw new OrchestrationError('APPLICATION_NOT_FOUND', 'Application not found');
  }
  if (existingApplication.status === 'SUBMITTED') {
    const run = await findRun(params.applicationId);
    return {
      automationRun: run ? safeAutomationRunView(run) : null,
      alreadySubmitted: true,
      reused: true,
      enqueued: false,
    };
  }

  // Full submission safety gate: explicit human approval, approved resume,
  // complete answers, mock-only target, supported ATS.
  const eligibility = await checkSubmissionEligibility({
    applicationId: params.applicationId,
    userId: params.userId,
  });

  const staleCutoff = new Date(Date.now() - (params.staleMs ?? DEFAULT_RUN_STALE_MS));
  const enqueue = params.enqueue ?? enqueueSubmissionJob;

  let run = await findRun(params.applicationId);

  // Fast path: a FRESH active run is reused as-is (idempotent repeat
  // requests). A stale QUEUED run means its job was lost and is re-queued
  // below via the same staleness recovery used for crashed RUNNING runs.
  if (
    run &&
    (run.status === 'QUEUED' || run.status === 'RUNNING') &&
    run.updatedAt >= staleCutoff
  ) {
    return {
      automationRun: safeAutomationRunView(run),
      alreadySubmitted: false,
      reused: true,
      enqueued: false,
    };
  }

  let claimed = false;
  if (!run) {
    // Atomic INSERT .. ON CONFLICT DO NOTHING on the applicationId unique
    // constraint: concurrent creates collapse into exactly one row.
    const inserted = await prisma.automationRun.createMany({
      data: [
        {
          userId: params.userId,
          applicationId: params.applicationId,
          provider: eligibility.provider,
          status: 'QUEUED',
          metadata: { kind: 'SUBMISSION' },
        },
      ],
      skipDuplicates: true,
    });
    claimed = inserted.count === 1;
    run = await findRun(params.applicationId);
    if (!run) {
      throw new OrchestrationError(
        'AUTOMATION_RUN_NOT_FOUND',
        'Automation run disappeared while queueing the submission'
      );
    }
  }

  if (!claimed) {
    // Conditional claim: only a finished (or crashed) run may be re-queued
    // for a submission attempt. Exactly one concurrent request can win this.
    const res = await prisma.automationRun.updateMany({
      where: {
        id: run.id,
        OR: [
          { status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] } },
          { status: 'RUNNING', updatedAt: { lt: staleCutoff } },
          { status: 'QUEUED', updatedAt: { lt: staleCutoff } },
        ],
      },
      data: {
        status: 'QUEUED',
        provider: eligibility.provider,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        metadata: { kind: 'SUBMISSION' },
      },
    });
    claimed = res.count === 1;
    const fresh = await prisma.automationRun.findUnique({ where: { id: run.id } });
    if (!fresh) {
      throw new OrchestrationError('AUTOMATION_RUN_NOT_FOUND', 'Automation run not found');
    }
    run = fresh;
  }

  if (!claimed) {
    // Another request/worker won the race - return the run, enqueue nothing.
    return {
      automationRun: safeAutomationRunView(run),
      alreadySubmitted: false,
      reused: true,
      enqueued: false,
    };
  }

  try {
    // Identifiers only - never answers, resume content, credentials, or PII.
    await enqueue({ applicationId: params.applicationId, automationRunId: run.id });
  } catch (err) {
    // The run must never sit QUEUED with no job behind it.
    await prisma.automationRun
      .updateMany({
        where: { id: run.id, status: 'QUEUED' },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorMessage: 'ENQUEUE_FAILED: the job queue is unavailable',
          metadata: { errorCode: 'ENQUEUE_FAILED' },
        },
      })
      .catch(() => undefined);
    throw new OrchestrationError(
      'ENQUEUE_FAILED',
      'The job queue is unavailable; no submission job was queued'
    );
  }

  return {
    automationRun: safeAutomationRunView(run),
    alreadySubmitted: false,
    reused: false,
    enqueued: true,
  };
}
