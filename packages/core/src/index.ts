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

// Application orchestration (Phase 13) - BullMQ queue + worker handler that
// asynchronously runs prepareApplication up to FORM_INSPECTED. Payloads are
// identifiers only; PostgreSQL stays the source of truth. Never submits.
// See ./orchestration.
export * from './orchestration';
