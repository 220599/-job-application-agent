/**
 * @jaa/ats - Generic ATS adapter foundation (Phase 7).
 *
 * Public API: the generic contract, the registry, and the error model.
 * Higher layers (packages/core, apps/api) depend on these types only -
 * never on a specific provider (Greenhouse comes in Phase 8) and never on
 * Playwright directly. All navigation is performed through @jaa/browser,
 * which enforces SSRF validation.
 */

// Contract & types
export type {
  AtsAdapter,
  AtsAdapterContext,
  AtsApplicationInspection,
  AtsApplicationPreparation,
  AtsField,
  AtsFieldLocator,
  AtsFieldOption,
  AtsFieldType,
  AtsPreparationStatus,
  AtsSecurityChallenge,
  AtsSecurityChallengeKind,
  AtsSubmissionContext,
  AtsSubmissionOutcome,
  AtsSubmissionResult,
  AtsSubmissionMode,
  AtsFieldFill,
  AtsSubmissionConfirmation,
} from './types';

// Mock submission envelope helpers (Phase 15A mock boundary)
export {
  MOCK_SUBMISSION_KIND,
  buildMockSubmissionScript,
  parseMockSubmissionResponse,
  challengeKindFor,
  isVerifiedSubmission,
} from './submission';
export type {
  MockSubmissionEnvelope,
  MockSubmissionResponse,
  MockSubmissionParseResult,
} from './submission';

// Error model
export { AtsError, isAtsError, atsErrorFromBrowserError } from './errors';
export type { AtsErrorCode } from './errors';

// Registry
export { AtsRegistry, createDefaultAtsRegistry } from './registry';
