export {
  OrchestrationError,
  isOrchestrationError,
  safeErrorMessage,
  safeAutomationRunView,
  PREPARATION_QUEUE_NAME,
  PREPARATION_MAX_ATTEMPTS,
  PREPARATION_BACKOFF_MS,
  DEFAULT_RUN_STALE_MS,
  PREPARABLE_APPLICATION_STATUSES,
  TERMINAL_APPLICATION_STATUSES,
} from './types';
export type {
  OrchestrationErrorCode,
  SafeAutomationRunView,
} from './types';

export { createPreparationRegistry } from './registry';
export type { PreparationRegistryOptions } from './registry';

export { checkPreparationEligibility } from './eligibility';
export type { EligibilityParams, EligibilityResult } from './eligibility';

export {
  getPreparationQueue,
  enqueuePreparationJob,
  closePreparationQueue,
  createPreparationWorker,
  redisConnectionOptions,
  PREPARATION_JOB_OPTIONS,
} from './queue';
export type { CreatePreparationWorkerOptions } from './queue';

export {
  requestApplicationPreparation,
  getApplicationAutomationRun,
  cancelApplicationAutomationRun,
  claimPreparationRun,
  touchAutomationRun,
} from './runs';
export type {
  RequestPreparationParams,
  RequestPreparationResult,
  ApplicationRunParams,
  ClaimRunResult,
  EnqueueFn,
} from './runs';

export { handlePreparationJob, classifyPreparationError } from './handler';
export type {
  PreparationJobContext,
  PreparationJobOutcome,
  ErrorClassification,
} from './handler';
