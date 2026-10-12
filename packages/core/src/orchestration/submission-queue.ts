import { Queue, Worker, type JobsOptions, type WorkerOptions } from 'bullmq';
import type { PreparationJobPayload } from '@jaa/shared';

import type { AtsRegistry } from '@jaa/ats';
import { handleSubmissionJob, type SubmissionJobFn } from './submission-handler';
import {
  SUBMISSION_QUEUE_NAME,
  SUBMISSION_MAX_ATTEMPTS,
  SUBMISSION_BACKOFF_MS,
  DEFAULT_RUN_STALE_MS,
} from './types';
import { redisConnectionOptions } from './queue';

/**
 * Phase 15A - the submission BullMQ queue.
 *
 * The SAME orchestration system as Phase 13, in its own lane: both the API
 * (producer) and apps/worker (consumer) go through this module, and the job
 * payload contract is the identical identifiers-only
 * PreparationJobPayload. A separate queue name keeps preparation and
 * submission jobs from interfering with each other; the retry policy,
 * connection handling, and durable-state conventions are shared with the
 * preparation queue.
 */

/**
 * Bounded, conservative retry policy: exponential backoff, few attempts.
 * Unknown-outcome and deterministic failures never retry (the handler
 * throws BullMQ's UnrecoverableError for those).
 */
export const SUBMISSION_JOB_OPTIONS: JobsOptions = {
  attempts: SUBMISSION_MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: SUBMISSION_BACKOFF_MS },
  // Keep Redis bounded; PostgreSQL is the durable record, not the job state.
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 24 * 3600, count: 1_000 },
};

const queues = new Map<string, Queue<PreparationJobPayload>>();

/**
 * Producer side (API). Fails fast when Redis is unreachable so the request
 * can surface ENQUEUE_FAILED instead of hanging. `queueName` is for tests
 * that need an isolated queue; production always uses the stable name.
 */
export function getSubmissionQueue(
  queueName: string = SUBMISSION_QUEUE_NAME
): Queue<PreparationJobPayload> {
  let queue = queues.get(queueName);
  if (!queue) {
    queue = new Queue<PreparationJobPayload>(queueName, {
      connection: { ...redisConnectionOptions(), enableOfflineQueue: false, maxRetriesPerRequest: 2 },
    });
    queues.set(queueName, queue);
  }
  return queue;
}

/** Enqueue a submission job. Payload is validated to be identifiers-only. */
export async function enqueueSubmissionJob(
  payload: PreparationJobPayload,
  options?: { queueName?: string }
): Promise<void> {
  const queue = getSubmissionQueue(options?.queueName);
  await queue.add('submit-application', payload, SUBMISSION_JOB_OPTIONS);
}

/** Close shared producers (process shutdown, test cleanup). */
export async function closeSubmissionQueue(): Promise<void> {
  const open = [...queues.values()];
  queues.clear();
  await Promise.all(open.map((queue) => queue.close().catch(() => undefined)));
}

export interface CreateSubmissionWorkerOptions {
  /** Test isolation only: process jobs from a non-default queue name. */
  queueName?: string;
  /** Override the Redis connection (tests). Default: REDIS_URL. */
  connection?: Record<string, unknown>;
  /** ATS registry passed through to submitApplication. */
  registry?: AtsRegistry;
  /** Test/dev only: allow loopback mock ATS servers. Default false. */
  allowPrivateUrls?: boolean;
  /** Parallel jobs per worker process. Default 1 (conservative). */
  concurrency?: number;
  /** Staleness threshold for crashed-run recovery. */
  staleMs?: number;
  /** Heartbeat interval while a job runs (keeps updatedAt fresh). */
  heartbeatMs?: number;
  /** Test seam - defaults to the real core submitApplication. */
  submit?: SubmissionJobFn;
}

/**
 * Consumer side (apps/worker). Thin wiring around handleSubmissionJob - all
 * orchestration logic lives in the handler so it is unit-testable without a
 * running worker process.
 */
export function createSubmissionWorker(
  options?: CreateSubmissionWorkerOptions
): Worker<PreparationJobPayload> {
  const staleMs = options?.staleMs ?? DEFAULT_RUN_STALE_MS;
  const workerOptions: WorkerOptions = {
    connection: options?.connection ?? {
      ...redisConnectionOptions(),
      // Required for Workers: commands must not be buffered per request.
      maxRetriesPerRequest: null,
    },
    concurrency: options?.concurrency ?? 1,
  };
  return new Worker<PreparationJobPayload>(
    options?.queueName ?? SUBMISSION_QUEUE_NAME,
    async (job) =>
      handleSubmissionJob(job.data, {
        attempt: (job.attemptsMade ?? 0) + 1,
        registry: options?.registry,
        allowPrivateUrls: options?.allowPrivateUrls ?? false,
        staleMs,
        heartbeatMs: options?.heartbeatMs,
        submit: options?.submit,
      }),
    workerOptions
  );
}
