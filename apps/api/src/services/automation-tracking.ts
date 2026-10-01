/**
 * AutomationRun tracking (Phase 6) now lives in packages/core so the
 * Phase 7 application preparation service can reuse it with the correct
 * dependency direction. This shim keeps the Phase 6 import path working.
 */
export {
  startAutomationRun,
  recordRunCurrentUrl,
  completeAutomationRun,
  getOrCreateAutomationRun,
} from '@jaa/core';
export type {
  StartAutomationRunParams,
  CompleteAutomationRunParams,
} from '@jaa/core';
