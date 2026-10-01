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

export { LeverAtsAdapter, LEVER_PROVIDER, classifyLeverField };
export type { LeverAdapterOptions, LeverFieldSemantic };
export { isLeverApplicationUrl };
export type { LeverRecognitionOptions };
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
