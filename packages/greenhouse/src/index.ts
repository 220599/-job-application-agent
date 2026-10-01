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
