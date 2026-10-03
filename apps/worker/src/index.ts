import dotenv from 'dotenv';

dotenv.config();

import {
  createPreparationWorker,
  closePreparationQueue,
  PREPARATION_QUEUE_NAME,
} from '@jaa/core';

/**
 * Phase 13 - BullMQ application preparation worker.
 *
 * Thin bootstrap only: all orchestration logic lives in
 * @jaa/core handlePreparationJob (validate payload -> load run/application ->
 * claim run -> prepareApplication -> FORM_INSPECTED -> COMPLETED). The worker
 * never submits applications.
 */
const allowPrivateUrls = process.env.JAA_ALLOW_PRIVATE_URLS === 'true';

console.log('[WORKER] Job queue processor starting...');
console.log('[WORKER] Environment:', process.env.NODE_ENV || 'development');
console.log('[WORKER] Redis URL:', process.env.REDIS_URL || 'redis://localhost:6379');
console.log('[WORKER] Queue:', PREPARATION_QUEUE_NAME);
console.log('[WORKER] Private URLs allowed:', allowPrivateUrls);

const worker = createPreparationWorker({
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

console.log('[WORKER] Waiting for preparation jobs...');

async function shutdown(signal: string): Promise<void> {
  console.log(`[WORKER] ${signal} received, shutting down gracefully...`);
  try {
    await worker.close();
    await closePreparationQueue();
  } catch {
    // Best effort - the process is exiting.
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
