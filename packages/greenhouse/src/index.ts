/**
 * @jaa/greenhouse - Greenhouse ATS adapter (Phase 8).
 *
 * Provider package: implements the generic @jaa/ats contract for
 * Greenhouse application forms. Dependency direction is strictly
 * packages/greenhouse -> @jaa/ats -> @jaa/browser; the generic ATS package
 * never learns about this provider. All navigation goes through
 * @jaa/browser (SSRF-validated) - this package never imports Playwright.
 */

import type { AtsRegistry } from '@jaa/ats';

import {
  GreenhouseAtsAdapter,
  GREENHOUSE_PROVIDER,
  classifyGreenhouseField,
  type GreenhouseAdapterOptions,
  type GreenhouseFieldSemantic,
} from './adapter';
import { isGreenhouseApplicationUrl, type GreenhouseRecognitionOptions } from './recognition';

export {
  GreenhouseAtsAdapter,
  GREENHOUSE_PROVIDER,
  classifyGreenhouseField,
};
export type { GreenhouseAdapterOptions, GreenhouseFieldSemantic };
export { isGreenhouseApplicationUrl };
export type { GreenhouseRecognitionOptions };
export type {
  GreenhouseRawField,
  GreenhouseRawFieldKind,
  GreenhouseRawOption,
  GreenhouseRawScan,
} from './dom-scan';

// Phase 15B.1 - documented, non-browser Job Board API submission path
// (employer-authorized; see docs/greenhouse-integration-options.md).
export {
  GREENHOUSE_JOB_BOARD_API_BASE,
  buildGreenhouseJobBoardRequestBody,
  fetchGreenhouseJobBoardQuestions,
  findUnansweredRequiredQuestions,
  isDefinitelyNotTransmitted,
  isLoopbackBaseUrl,
  resolveJobBoardApiBase,
  submitGreenhouseJobBoardApplication,
  validateGreenhouseJobBoardApplication,
} from './job-board-api';
export type {
  GreenhouseJobBoardAnswer,
  GreenhouseJobBoardApplicationInput,
  GreenhouseJobBoardAttachment,
  GreenhouseJobBoardQuestion,
  GreenhouseJobBoardQuestionField,
  GreenhouseJobBoardQuestionFieldValue,
  GreenhouseJobBoardSubmissionOptions,
  GreenhouseJobBoardSubmissionResult,
  GreenhouseJobBoardViolation,
} from './job-board-api';

// Phase 15B.2 - Job Board API orchestration glue (path selection, answer
// mapping to documented field names; vendor-specific, server-side only).
export {
  GREENHOUSE_JOB_BOARD_API_BASE_ENV,
  GREENHOUSE_JOB_BOARD_API_KEY_ENV,
  buildGreenhouseJobBoardInput,
  parseGreenhouseJobBoardTarget,
  resolveGreenhouseJobBoardApiConfig,
  selectGreenhouseSubmissionPath,
} from './job-board-submission';
export type {
  GreenhouseJobBoardApiConfig,
  GreenhouseJobBoardInputBuild,
  GreenhouseJobBoardTarget,
  GreenhouseSubmissionPath,
  GreenhouseSubmissionPathSelection,
} from './job-board-submission';

/**
 * Register the Greenhouse adapter on a Phase 7 AtsRegistry. The registry
 * itself stays provider independent - this helper only plugs the adapter
 * in through the standard registration API.
 */
export function registerGreenhouseAdapter(
  registry: AtsRegistry,
  options?: GreenhouseAdapterOptions
): GreenhouseAtsAdapter {
  const adapter = new GreenhouseAtsAdapter(options);
  registry.register(adapter);
  return adapter;
}
