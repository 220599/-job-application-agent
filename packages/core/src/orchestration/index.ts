export {
  OrchestrationError,
  isOrchestrationError,
  safeErrorMessage,
  safeAutomationRunView,
  PREPARATION_QUEUE_NAME,
  PREPARATION_MAX_ATTEMPTS,
  PREPARATION_BACKOFF_MS,
  SUBMISSION_QUEUE_NAME,
  SUBMISSION_MAX_ATTEMPTS,
  SUBMISSION_BACKOFF_MS,
  SUBMITTABLE_APPLICATION_STATUSES,
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

// Phase 15A - mock application submission (the same orchestration system,
// its own lane: identifiers-only payloads, PostgreSQL source of truth,
// bounded retries, and a crash-safety attempt ledger).
export {
  checkSubmissionEligibility,
  checkSubmissionSafetyGate,
  checkSubmissionReadiness,
  checkSubmissionAnswers,
  resolveSubmissionTarget,
  assertMockSubmissionTarget,
  isLoopbackUrl,
} from './submission-eligibility';

// Phase 15B/15C - controlled real submission capabilities. Each switch is
// server-side only (JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED for Greenhouse,
// JAA_REAL_LEVER_SUBMISSION_ENABLED for Lever), disabled by default,
// provider-scoped (one flag can never enable the other provider), and
// SSRF-validated.
export {
  REAL_GREENHOUSE_SUBMISSION_FLAG,
  REAL_LEVER_SUBMISSION_FLAG,
  REAL_SUBMISSION_PROVIDER,
  REAL_LEVER_SUBMISSION_PROVIDER,
  isRealGreenhouseSubmissionEnabled,
  isRealLeverSubmissionEnabled,
  assertRealGreenhouseSubmissionEnabled,
  assertRealLeverSubmissionEnabled,
  assertAnyRealSubmissionCapabilityEnabled,
  assertRealGreenhouseSubmissionTarget,
  assertRealLeverSubmissionTarget,
  assertSubmissionTarget,
  resolveSubmissionMode,
} from '../submission-policy';
export type { SubmissionTargetMode } from '../submission-policy';
export type {
  SubmissionEligibilityParams,
  SubmissionEligibilityResult,
  SubmissionAnswerProblem,
} from './submission-eligibility';

export { requestApplicationSubmission } from './submission-runs';
export type {
  RequestSubmissionParams,
  RequestSubmissionResult,
  EnqueueSubmissionFn,
} from './submission-runs';

export {
  getSubmissionQueue,
  enqueueSubmissionJob,
  closeSubmissionQueue,
  createSubmissionWorker,
  SUBMISSION_JOB_OPTIONS,
} from './submission-queue';
export type { CreateSubmissionWorkerOptions } from './submission-queue';

export { handleSubmissionJob } from './submission-handler';
export type {
  SubmissionJobContext,
  SubmissionJobOutcome,
  SubmissionJobFn,
} from './submission-handler';
