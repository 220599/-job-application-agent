import type { JaaBrowserContext, JaaPage } from '@jaa/browser';

/**
 * Phase 7 - Provider-independent ATS types.
 *
 * This is the generic contract every ATS provider implements (Greenhouse in
 * Phase 8, later Lever/Workday/Ashby). Higher layers depend ONLY on these
 * types - never on a specific provider and never on Playwright.
 *
 * Security: no secrets or credentials belong in these types. The browser
 * page/context wrappers come from @jaa/browser, which enforces SSRF
 * validation on every navigation.
 */

/** Normalized field types, aligned with the Prisma ApplicationQuestion.fieldType. */
export type AtsFieldType =
  | 'TEXT'
  | 'TEXTAREA'
  | 'EMAIL'
  | 'PHONE'
  | 'SELECT'
  | 'RADIO'
  | 'CHECKBOX'
  | 'FILE'
  | 'DATE'
  | 'NUMBER'
  | 'UNKNOWN';

/** One selectable option of a SELECT/RADIO field. */
export interface AtsFieldOption {
  value: string;
  label: string;
}

/**
 * How to locate the field on the page. Kept as structured data (never a
 * Playwright object) so it can be persisted into ApplicationQuestion.locator.
 */
export interface AtsFieldLocator {
  cssSelector?: string;
  /** Non-standard attributes that help re-find the field (name, data-*) */
  attributes?: Record<string, string>;
}

/**
 * A discovered application form field. Maps cleanly onto the existing
 * Prisma ApplicationQuestion model:
 *   externalFieldId -> externalFieldId
 *   label           -> label
 *   normalizedLabel -> normalizedLabel
 *   type            -> fieldType
 *   required        -> required
 *   options         -> options (Json)
 *   section         -> section
 *   locator         -> locator (Json)
 */
export interface AtsField {
  externalFieldId?: string | null;
  label: string;
  normalizedLabel?: string | null;
  type: AtsFieldType;
  required: boolean;
  options?: AtsFieldOption[] | null;
  section?: string | null;
  locator?: AtsFieldLocator | null;
}

/**
 * Everything an adapter needs. Only the public @jaa/browser wrappers are
 * included - never raw Playwright handles, never secrets or credentials.
 */
export interface AtsAdapterContext {
  /** Application page URL (already SSRF-validated when navigation happens). */
  url: string;
  /** Browser page wrapper from @jaa/browser. */
  page: JaaPage;
  /** The owning isolated browser context, when the adapter needs more pages. */
  browserContext?: JaaBrowserContext;
  /** Identifiers for audit trails, where available. */
  jobId?: string;
  applicationId?: string;
  userId?: string;
  /** Provider hints (e.g. job source data). Never secrets. */
  metadata?: Record<string, unknown>;
}

/** Result of inspecting an application page. */
export interface AtsApplicationInspection {
  provider: string;
  url: string;
  pageTitle: string | null;
  /** Does the page appear to be an application form at all? */
  isApplicationForm: boolean;
  fields: AtsField[];
  warnings: string[];
  blockers: string[];
}

export type AtsPreparationStatus = 'READY' | 'NEEDS_REVIEW' | 'BLOCKED' | 'FAILED';

/**
 * Result of preparing an application WITHOUT submitting it. Actual field
 * mapping (Phase 9) and AI answers (Phase 10) come later - in Phase 7 the
 * mock adapter returns NEEDS_REVIEW for a recognized form.
 */
export interface AtsApplicationPreparation {
  provider: string;
  url: string;
  status: AtsPreparationStatus;
  inspection: AtsApplicationInspection | null;
  warnings: string[];
  errors: string[];
}

/**
 * The generic ATS contract. Providers implement this; higher layers call
 * it through the registry. Adapters must never submit applications and
 * must never transition an application to SUBMITTED.
 */
export interface AtsAdapter {
  /** Provider identifier, e.g. "GREENHOUSE", "MOCK". */
  readonly provider: string;
  /** Human readable provider name. */
  readonly name: string;
  /** Can this adapter handle the given URL? Must be pure/deterministic. */
  canHandle(url: string): boolean;
  /** Navigate to and inspect the application page. */
  inspectApplication(context: AtsAdapterContext): Promise<AtsApplicationInspection>;
  /** Prepare the application (no submission). */
  prepareApplication(context: AtsAdapterContext): Promise<AtsApplicationPreparation>;
}
