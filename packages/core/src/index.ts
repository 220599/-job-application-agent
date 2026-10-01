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
