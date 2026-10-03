import { prisma } from '@jaa/database';
import type { AutomationRun } from '@prisma/client';
import type { PreparationJobPayload } from '@jaa/shared';
import type { AtsRegistry } from '@jaa/ats';

import { checkPreparationEligibility } from './eligibility';
import { enqueuePreparationJob } from './queue';
import {
  OrchestrationError,
  DEFAULT_RUN_STALE_MS,
  safeAutomationRunView,
  type SafeAutomationRunView,
} from './types';

/**
 * Phase 13 - AutomationRun lifecycle for queued preparation.
 *
 * Idempotency is enforced in PostgreSQL, not in memory:
 *   - `AutomationRun.applicationId` is @unique, so there is at most ONE run
 *     row per application, ever (concurrent creates collapse via P2002);
 *   - enqueueing happens only after a CONDITIONAL state transition
 *     (updateMany with a status predicate) wins the race - losing requests
 *     return the existing run and enqueue nothing.
 * A single BullMQ job is therefore never duplicated for an application.
 */

export type EnqueueFn = (payload: PreparationJobPayload) => Promise<void>;

export interface RequestPreparationParams {
  applicationId: string;
  userId: string;
  registry?: AtsRegistry;
  /** Staleness threshold for crashed-run recovery. */
  staleMs?: number;
  /** Test seam: replace the real BullMQ enqueue. */
  enqueue?: EnqueueFn;
}

export interface RequestPreparationResult {
  automationRun: SafeAutomationRunView;
  /** True when an already-active run was returned as-is (idempotent). */
  reused: boolean;
  /** True when THIS call queued a new BullMQ job. */
  enqueued: boolean;
}

async function findRun(applicationId: string): Promise<AutomationRun | null> {
  return prisma.automationRun.findUnique({ where: { applicationId } });
}

/**
 * Queue application preparation. Returns the existing active run (and queues
 * nothing) when one is already QUEUED/RUNNING; otherwise atomically claims
 * the run for a fresh attempt and enqueues exactly one job.
 */
export async function requestApplicationPreparation(
  params: RequestPreparationParams
): Promise<RequestPreparationResult> {
  const eligibility = await checkPreparationEligibility({
    applicationId: params.applicationId,
    userId: params.userId,
    registry: params.registry,
  });

  const staleCutoff = new Date(Date.now() - (params.staleMs ?? DEFAULT_RUN_STALE_MS));
  const enqueue = params.enqueue ?? enqueuePreparationJob;

  let run = await findRun(params.applicationId);

  // Fast path: a FRESH active run is reused as-is (idempotent repeat
  // requests). A stale QUEUED run means its job was lost (crash before
  // enqueue / Redis loss) and is re-queued below via the same staleness
  // recovery used for crashed RUNNING runs.
  if (
    run &&
    (run.status === 'QUEUED' || run.status === 'RUNNING') &&
    run.updatedAt >= staleCutoff
  ) {
    return { automationRun: safeAutomationRunView(run), reused: true, enqueued: false };
  }

  let claimed = false;
  if (!run) {
    // Atomic INSERT .. ON CONFLICT DO NOTHING on the applicationId unique
    // constraint: concurrent creates collapse into exactly one row (and no
    // noisy constraint error), the loser falls through to the claim path.
    const inserted = await prisma.automationRun.createMany({
      data: [
        {
          userId: params.userId,
          applicationId: params.applicationId,
          provider: eligibility.provider,
          status: 'QUEUED',
          metadata: {},
        },
      ],
      skipDuplicates: true,
    });
    claimed = inserted.count === 1;
    // Winner or loser, the row now exists exactly once - load it.
    run = await findRun(params.applicationId);
    if (!run) {
      throw new OrchestrationError(
        'AUTOMATION_RUN_NOT_FOUND',
        'Automation run disappeared while queueing preparation'
      );
    }
  }

  if (!claimed) {
    // Conditional claim: only a finished run (or a crashed RUNNING one) may
    // be re-queued. Exactly one concurrent request can win this transition.
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
        metadata: {},
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
    // Another request/worker won the race and owns the transition - return
    // the current run without enqueueing a duplicate job.
    return { automationRun: safeAutomationRunView(run), reused: true, enqueued: false };
  }

  try {
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
      'The job queue is unavailable; no preparation job was queued'
    );
  }

  return { automationRun: safeAutomationRunView(run), reused: false, enqueued: true };
}

export interface ApplicationRunParams {
  applicationId: string;
  userId: string;
}

/** Safe automation status for an application (never leaks other users' runs). */
export async function getApplicationAutomationRun(
  params: ApplicationRunParams
): Promise<SafeAutomationRunView | null> {
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
  });
  if (!application || application.userId !== params.userId) {
    throw new OrchestrationError('APPLICATION_NOT_FOUND', 'Application not found');
  }
  const run = await findRun(params.applicationId);
  return run ? safeAutomationRunView(run) : null;
}

/**
 * Cancel a queued run. Only QUEUED runs can be cancelled: a RUNNING
 * preparation owns a live browser session and is never terminated
 * unsafely. Idempotent - cancelling a CANCELLED run succeeds unchanged.
 */
export async function cancelApplicationAutomationRun(
  params: ApplicationRunParams
): Promise<{ automationRun: SafeAutomationRunView; changed: boolean }> {
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
  });
  if (!application || application.userId !== params.userId) {
    throw new OrchestrationError('APPLICATION_NOT_FOUND', 'Application not found');
  }
  const run = await findRun(params.applicationId);
  if (!run) {
    throw new OrchestrationError('AUTOMATION_RUN_NOT_FOUND', 'Automation run not found');
  }
  if (run.status === 'CANCELLED') {
    return { automationRun: safeAutomationRunView(run), changed: false };
  }

  const res = await prisma.automationRun.updateMany({
    where: { id: run.id, status: 'QUEUED' },
    data: {
      status: 'CANCELLED',
      completedAt: new Date(),
      metadata: { errorCode: 'CANCELLED' },
    },
  });
  if (res.count === 1) {
    const fresh = await prisma.automationRun.findUnique({ where: { id: run.id } });
    return { automationRun: safeAutomationRunView(fresh!), changed: true };
  }

  const current = await prisma.automationRun.findUnique({ where: { id: run.id } });
  if (current && current.status === 'CANCELLED') {
    return { automationRun: safeAutomationRunView(current), changed: false };
  }
  throw new OrchestrationError(
    'AUTOMATION_NOT_CANCELLABLE',
    'Only a queued automation run can be cancelled'
  );
}

export type ClaimRunResult =
  | { claimed: true; run: AutomationRun }
  | {
      claimed: false;
      run: AutomationRun | null;
      reason: 'NOT_FOUND' | 'CANCELLED' | 'COMPLETED' | 'ACTIVE' | 'NOT_CLAIMABLE';
    };

/**
 * Conditional QUEUED/FAILED -> RUNNING transition for the worker.
 *
 * This is the concurrency guard: two workers racing on the same application
 * can never both become active, because the updateMany predicate is
 * serialized by the database row lock. A stale RUNNING run (worker crashed -
 * no heartbeat within staleMs) may be reclaimed.
 */
export async function claimPreparationRun(params: {
  runId: string;
  staleMs?: number;
}): Promise<ClaimRunResult> {
  const run = await prisma.automationRun.findUnique({ where: { id: params.runId } });
  if (!run) return { claimed: false, run: null, reason: 'NOT_FOUND' };
  if (run.status === 'CANCELLED') return { claimed: false, run, reason: 'CANCELLED' };
  if (run.status === 'COMPLETED') return { claimed: false, run, reason: 'COMPLETED' };

  const staleCutoff = new Date(Date.now() - (params.staleMs ?? DEFAULT_RUN_STALE_MS));
  const res = await prisma.automationRun.updateMany({
    where: {
      id: run.id,
      OR: [
        { status: { in: ['QUEUED', 'FAILED'] } },
        { status: 'RUNNING', updatedAt: { lt: staleCutoff } },
      ],
    },
    data: {
      status: 'RUNNING',
      startedAt: new Date(),
      completedAt: null,
      errorMessage: null,
      metadata: {},
    },
  });
  if (res.count === 1) {
    const fresh = await prisma.automationRun.findUnique({ where: { id: run.id } });
    return { claimed: true, run: fresh! };
  }

  const current = await prisma.automationRun.findUnique({ where: { id: run.id } });
  const reason =
    current?.status === 'RUNNING'
      ? 'ACTIVE'
      : current?.status === 'CANCELLED'
        ? 'CANCELLED'
        : current?.status === 'COMPLETED'
          ? 'COMPLETED'
          : 'NOT_CLAIMABLE';
  return { claimed: false, run: current, reason };
}

/**
 * Heartbeat: bump `updatedAt` on a RUNNING run so a live preparation is
 * never mistaken for a crashed one. Cheap, and uses only existing fields.
 */
export async function touchAutomationRun(runId: string): Promise<void> {
  await prisma.automationRun
    .updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { updatedAt: new Date() },
    })
    .catch(() => undefined);
}
