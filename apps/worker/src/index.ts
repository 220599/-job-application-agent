import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load env vars: local apps/worker/.env first, then repo root .env (no
// override) - same as the API; the root .env carries DATABASE_URL/REDIS_URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import {
  createPreparationWorker,
  createSubmissionWorker,
  closePreparationQueue,
  closeSubmissionQueue,
  PREPARATION_QUEUE_NAME,
  SUBMISSION_QUEUE_NAME,
} from '@jaa/core';

/**
 * Phase 13/15A - BullMQ application workers.
 *
 * Thin bootstrap only: all orchestration logic lives in @jaa/core.
 *  - handlePreparationJob: validate payload -> load run/application -> claim
 *    run -> prepareApplication -> FORM_INSPECTED -> COMPLETED. Never submits.
 *  - handleSubmissionJob: validate payload -> safety gate -> claim run ->
 *    submitApplication -> LOOPBACK mock ATS -> SUBMITTED. Phase 15A is
 *    mock-only by policy: without JAA_ALLOW_MOCK_SUBMISSION=true (and never
 *    in production) no submission can happen at all, and the submission
 *    policy refuses any non-loopback target - so no code path here can ever
 *    submit a real application.
 */
const allowPrivateUrls = process.env.JAA_ALLOW_PRIVATE_URLS === 'true';

console.log('[WORKER] Job queue processor starting...');
console.log('[WORKER] Environment:', process.env.NODE_ENV || 'development');
console.log('[WORKER] Redis URL:', process.env.REDIS_URL || 'redis://localhost:6379');
console.log('[WORKER] Queues:', PREPARATION_QUEUE_NAME, SUBMISSION_QUEUE_NAME);
console.log('[WORKER] Private URLs allowed:', allowPrivateUrls);
console.log('[WORKER] Mock submission enabled:', process.env.JAA_ALLOW_MOCK_SUBMISSION === 'true');

const worker = createPreparationWorker({
  concurrency: Number(process.env.WORKER_CONCURRENCY) || 1,
  allowPrivateUrls,
});

const submissionWorker = createSubmissionWorker({
  concurrency: Number(process.env.WORKER_CONCURRENCY) || 1,
  allowPrivateUrls,
});

worker.on('completed', (job) => {
  console.log(`[WORKER] Job ${job.id} completed (application ${job.data.applicationId})`);
});
worker.on('failed', (job, err) => {
  console.error(`[WORKER] Job ${job?.id} failed: ${err.name}: ${err.message}`);
});
worker.on('error', (err) => {
  console.error('[WORKER] Worker error:', err.message);
});

submissionWorker.on('completed', (job) => {
  console.log(`[WORKER] Submission job ${job.id} completed (application ${job.data.applicationId})`);
});
submissionWorker.on('failed', (job, err) => {
  console.error(`[WORKER] Submission job ${job?.id} failed: ${err.name}: ${err.message}`);
});
submissionWorker.on('error', (err) => {
  console.error('[WORKER] Submission worker error:', err.message);
});

console.log('[WORKER] Waiting for preparation and submission jobs...');

async function shutdown(signal: string): Promise<void> {
  console.log(`[WORKER] ${signal} received, shutting down gracefully...`);
  try {
    await worker.close();
    await submissionWorker.close();
    await closePreparationQueue();
    await closeSubmissionQueue();
  } catch {
    // Best effort - the process is exiting.
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
