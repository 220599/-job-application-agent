/**
 * @jaa/core - Core business logic.
 *
 * Layering: apps/api -> @jaa/core -> @jaa/ats -> @jaa/browser.
 * Core never imports Playwright directly; all browser access goes through
 * the public @jaa/browser API.
 */

// AutomationRun tracking (moved here from apps/api in Phase 7)
export {
  startAutomationRun,
  recordRunCurrentUrl,
  completeAutomationRun,
  getOrCreateAutomationRun,
} from './automation-tracking';
export type {
  StartAutomationRunParams,
  CompleteAutomationRunParams,
} from './automation-tracking';

// Application preparation (Phase 7)
export { prepareApplication } from './application-preparation';
export type {
  PrepareApplicationParams,
  PrepareApplicationResult,
} from './application-preparation';

// AI application question answering (Phase 10) - generates answers only,
// never submits. See ./answer-generation for the full pipeline.
export * from './answer-generation';

// Resume tailoring and versioning (Phase 11) - AI tailoring into immutable
// ResumeVersions with deterministic anti-fabrication validation. See
// ./resume-tailoring for the full pipeline.
export * from './resume-tailoring';

// Human review workspace (Phase 12) - review, approve, reject tailored
// resume versions; human edits create new immutable versions. Never submits
// anything and never changes Application.status. See ./resume-review.
export * from './resume-review';

// Application submission (Phase 15A) - the explicit human approval action
// and the MOCK submission workflow (local mock ATS servers only, enforced by
// policy). Owns every submission state change and the crash-safety attempt
// ledger. See ./application-submission.
export {
  approveApplicationForSubmission,
  submitApplication,
  findUnresolvedSubmissionAttempt,
  hasSubmissionAttemptHistory,
  SimulatedWorkerCrash,
  isSimulatedWorkerCrash,
} from './application-submission';
export type {
  ApproveApplicationParams,
  ApproveApplicationResult,
  SubmitApplicationParams,
  SubmitApplicationResult,
} from './application-submission';

// Application orchestration (Phase 13/15A) - BullMQ queues + worker
// handlers that asynchronously run prepareApplication up to FORM_INSPECTED
// and the mock submission workflow up to SUBMITTED. Payloads are identifiers
// only; PostgreSQL stays the source of truth. See ./orchestration.
export * from './orchestration';
