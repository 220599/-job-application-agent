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

// Resume tailoring and versioning (Phase 11) - creates a NEW immutable
// ResumeVersion tailored to a Job, ready for human review. Never fills forms,
// never submits, never mutates a source version. See ./resume-tailoring.
export * from './resume-tailoring';
