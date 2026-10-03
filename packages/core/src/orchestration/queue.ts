import { Queue, Worker, type JobsOptions, type WorkerOptions } from 'bullmq';
import type { PreparationJobPayload } from '@jaa/shared';

import { prepareApplication } from '../application-preparation';
import type { AtsRegistry } from '@jaa/ats';
import { handlePreparationJob } from './handler';
import {
  PREPARATION_QUEUE_NAME,
  PREPARATION_MAX_ATTEMPTS,
  PREPARATION_BACKOFF_MS,
  DEFAULT_RUN_STALE_MS,
} from './types';

/**
 * Phase 13 - the single BullMQ queue abstraction.
 *
 * Both the API (producer) and apps/worker (consumer) go through this module,
 * so the queue name, job contract, and retry policy exist in exactly one
 * place. The payload contract is identifiers-only (see
 * preparationJobPayloadSchema in @jaa/shared).
 */

/** ioredis connection options derived from REDIS_URL (default localhost). */
export function redisConnectionOptions(): Record<string, unknown> {
  const raw = process.env.REDIS_URL || 'redis://localhost:6379';
  try {
    const url = new URL(raw);
    const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : undefined;
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: url.password } : {}),
      ...(url.username ? { username: url.username } : {}),
      ...(Number.isFinite(db) ? { db } : {}),
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

/**
 * Bounded, conservative retry policy: exponential backoff, few attempts.
 * Deterministic failures never retry (the handler throws BullMQ's
 * UnrecoverableError for those).
 */
export const PREPARATION_JOB_OPTIONS: JobsOptions = {
  attempts: PREPARATION_MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: PREPARATION_BACKOFF_MS },
  // Keep Redis bounded; PostgreSQL is the durable record, not the job state.
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 24 * 3600, count: 1_000 },
};

const queues = new Map<string, Queue<PreparationJobPayload>>();

/**
 * Producer side (API). Fails fast when Redis is unreachable so the request
 * can surface ENQUEUE_FAILED instead of hanging on an offline command queue.
 * `queueName` is for tests that need an isolated queue; production always
 * uses the single stable queue name.
 */
export function getPreparationQueue(
  queueName: string = PREPARATION_QUEUE_NAME
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

/** Enqueue a preparation job. Payload is validated to be identifiers-only. */
export async function enqueuePreparationJob(
  payload: PreparationJobPayload,
  options?: { queueName?: string }
): Promise<void> {
  const queue = getPreparationQueue(options?.queueName);
  await queue.add('prepare-application', payload, PREPARATION_JOB_OPTIONS);
}

/** Close shared producers (process shutdown, test cleanup). */
export async function closePreparationQueue(): Promise<void> {
  const open = [...queues.values()];
  queues.clear();
  await Promise.all(open.map((queue) => queue.close().catch(() => undefined)));
}

export interface CreatePreparationWorkerOptions {
  /** Test isolation only: process jobs from a non-default queue name. */
  queueName?: string;
  /** Override the Redis connection (tests). Default: REDIS_URL. */
  connection?: Record<string, unknown>;
  /** ATS registry passed through to prepareApplication. */
  registry?: AtsRegistry;
  /** Test/dev only: allow loopback mock ATS servers. Default false. */
  allowPrivateUrls?: boolean;
  /** Parallel jobs per worker process. Default 1 (conservative). */
  concurrency?: number;
  /** Staleness threshold for crashed-run recovery. */
  staleMs?: number;
  /** Heartbeat interval while a job runs (keeps updatedAt fresh). */
  heartbeatMs?: number;
}

/**
 * Consumer side (apps/worker). Thin wiring around handlePreparationJob -
 * all orchestration logic lives in the handler so it is unit-testable
 * without a running worker process.
 */
export function createPreparationWorker(
  options?: CreatePreparationWorkerOptions
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
    options?.queueName ?? PREPARATION_QUEUE_NAME,
    async (job) =>
      handlePreparationJob(job.data, {
        attempt: (job.attemptsMade ?? 0) + 1,
        registry: options?.registry,
        allowPrivateUrls: options?.allowPrivateUrls ?? false,
        staleMs,
        heartbeatMs: options?.heartbeatMs,
      }),
    workerOptions
  );
}
