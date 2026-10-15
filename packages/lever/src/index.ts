/**
 * @jaa/lever - Lever ATS adapter (Phase 9).
 *
 * Provider package: implements the generic @jaa/ats contract for Lever
 * application forms. Dependency direction is strictly
 * packages/lever -> @jaa/ats -> @jaa/browser; the generic ATS package
 * never learns about this provider. All navigation goes through
 * @jaa/browser (SSRF-validated) - this package never imports Playwright.
 */

import type { AtsRegistry } from '@jaa/ats';

import {
  LeverAtsAdapter,
  LEVER_PROVIDER,
  classifyLeverField,
  type LeverAdapterOptions,
  type LeverFieldSemantic,
} from './adapter';
import { isLeverApplicationUrl, type LeverRecognitionOptions } from './recognition';
import {
  LEVER_API_BASE,
  MAX_LEVER_UPLOAD_BYTES,
  extractLeverApplyReference,
  fetchLeverApplyQuestions,
  isDefinitelyNotTransmitted,
  isLoopbackBaseUrl,
  parseLeverApplyQuestions,
  resolveLeverApiBase,
  submitLeverApplyApplication,
  uploadLeverApplyFile,
  validateLeverApplyApplication,
  validateLeverUploadFile,
  type LeverApplyField,
  type LeverApplyFieldOption,
  type LeverApplyInput,
  type LeverApplyPersonalValue,
  type LeverApplyQuestionSet,
  type LeverApplyQuestions,
  type LeverApplySubmissionOptions,
  type LeverApplySubmissionResult,
  type LeverApplyViolation,
  type LeverUploadResult,
} from './apply-api';
import {
  LEVER_API_BASE_ENV,
  LEVER_API_KEY_ENV,
  buildLeverApplyInput,
  parseLeverPostingTarget,
  resolveLeverApiConfig,
  selectLeverSubmissionPath,
  withLeverResumeUri,
  type LeverApiConfig,
  type LeverApplyInputBuild,
  type LeverPostingTarget,
  type LeverSubmissionPath,
  type LeverSubmissionPathSelection,
} from './apply-submission';

export { LeverAtsAdapter, LEVER_PROVIDER, classifyLeverField };
export type { LeverAdapterOptions, LeverFieldSemantic };
export { isLeverApplicationUrl };
export type { LeverRecognitionOptions };

// Documented Apply API client (Phase 15C)
export {
  LEVER_API_BASE,
  MAX_LEVER_UPLOAD_BYTES,
  extractLeverApplyReference,
  fetchLeverApplyQuestions,
  isDefinitelyNotTransmitted,
  isLoopbackBaseUrl,
  parseLeverApplyQuestions,
  resolveLeverApiBase,
  submitLeverApplyApplication,
  uploadLeverApplyFile,
  validateLeverApplyApplication,
  validateLeverUploadFile,
};
export type {
  LeverApplyField,
  LeverApplyFieldOption,
  LeverApplyInput,
  LeverApplyPersonalValue,
  LeverApplyQuestionSet,
  LeverApplyQuestions,
  LeverApplySubmissionOptions,
  LeverApplySubmissionResult,
  LeverApplyViolation,
  LeverUploadResult,
};

// Path selection + answer mapping (Phase 15C)
export {
  LEVER_API_BASE_ENV,
  LEVER_API_KEY_ENV,
  buildLeverApplyInput,
  parseLeverPostingTarget,
  resolveLeverApiConfig,
  selectLeverSubmissionPath,
  withLeverResumeUri,
};
export type {
  LeverApiConfig,
  LeverApplyInputBuild,
  LeverPostingTarget,
  LeverSubmissionPath,
  LeverSubmissionPathSelection,
};
export type { LeverRawField, LeverRawFieldKind, LeverRawOption, LeverRawScan } from './dom-scan';

/**
 * Register the Lever adapter on a Phase 7 AtsRegistry. The registry
 * itself stays provider independent - this helper only plugs the adapter
 * in through the standard registration API.
 */
export function registerLeverAdapter(
  registry: AtsRegistry,
  options?: LeverAdapterOptions
): LeverAtsAdapter {
  const adapter = new LeverAtsAdapter(options);
  registry.register(adapter);
  return adapter;
}
