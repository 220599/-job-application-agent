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

// ============================================================================
// Submission boundary (Phase 15A - MOCK submission only)
// ============================================================================

/**
 * A security challenge detected on the page. These STOP any submission
 * immediately - they are never solved, bypassed, or worked around.
 */
export type AtsSecurityChallengeKind =
  | 'CAPTCHA'
  | 'MFA'
  | 'SECURITY_CHALLENGE'
  | 'BOT_CHALLENGE';

export interface AtsSecurityChallenge {
  kind: AtsSecurityChallengeKind;
  /** Provider/marker tag detected on the page (e.g. "g-recaptcha", "mfa"). */
  detail: string;
}

/**
 * Everything an adapter needs to attempt a submission. For the MOCK path
 * only identifiers and counts are used - never answer text, never resume
 * content, never candidate PII. For the REAL path (Phase 15B, Greenhouse
 * only, behind the server capability) the prepared field values are provided
 * in `fieldFills` so the adapter can fill the live form. These values are
 * passed IN-MEMORY from the core workflow to the adapter - they never appear
 * in BullMQ payloads or ApplicationEvent metadata.
 */
export interface AtsSubmissionContext extends AtsAdapterContext {
  /** Durable per-attempt identifier (mirrors the SUBMISSION_STARTED event). */
  submissionAttemptId: string;
  /** Number of inspected form fields. A count, never field content. */
  fieldCount: number;
  /** Number of answered required questions. A count, never answer text. */
  requiredAnswerCount: number;
  /**
   * MOCK (loopback envelope) or REAL (fill + submit the live form). Decided
   * ONLY by the server capability policy - never by client input. Defaults
   * to MOCK, preserving Phase 15A behavior.
   */
  submissionMode?: AtsSubmissionMode;
  /**
   * Prepared field values to fill for a REAL submission. Empty/absent for
   * the MOCK path. In-memory only - never serialized into a queue payload.
   */
  fieldFills?: AtsFieldFill[];
  /** Absolute path of the approved resume file for FILE uploads (REAL only). */
  resumeFile?: string | null;
}

export type AtsSubmissionMode = 'MOCK' | 'REAL';

/**
 * One prepared field value for a REAL form fill. `value` is the answer text;
 * it is used only to fill the live form and is never logged or persisted to
 * events.
 */
export interface AtsFieldFill {
  questionId: string;
  fieldType: AtsFieldType;
  locator: AtsFieldLocator | null;
  value: string;
  required: boolean;
  options?: AtsFieldOption[] | null;
  /**
   * The human-readable question label (from the inspected form). Optional:
   * providers that submit through a documented non-browser API need it to
   * map the approved answer onto the provider's documented field names.
   * Never PII - it is the form's own question text.
   */
  label?: string | null;
  /** The provider's external field identifier from inspection, when known. */
  externalFieldId?: string | null;
}

/**
 * How a REAL submission was confirmed by the provider (Phase 15B). The
 * strongest available evidence is used and nothing is ever faked:
 *  - PROVIDER_ID  : the provider exposed a stable application/confirmation id;
 *  - SUCCESS_PAGE : a confirmed success/confirmation page was detected (form
 *                   gone + explicit application-received confirmation);
 *  - HTTP_ACCEPTED: a documented submission endpoint answered 2xx to the
 *                   authenticated submission request itself, but exposed no
 *                   id. This is the weakest tier: the endpoint's documented
 *                   contract IS the submission, so its success response is
 *                   the documented success signal - but no independent
 *                   lookup or confirmation id exists to strengthen it.
 */
export interface AtsSubmissionConfirmation {
  method: 'PROVIDER_ID' | 'SUCCESS_PAGE' | 'HTTP_ACCEPTED';
  /** Provider application/confirmation reference, when one is exposed. */
  reference: string | null;
  /** URL of the confirmed success page. */
  url: string | null;
}

export type AtsSubmissionOutcome = 'SUBMITTED' | 'REJECTED' | 'CHALLENGE_DETECTED';

/**
 * Result of a submission attempt against the (mock) ATS.
 *
 *  - SUBMITTED: the ATS answered with a verifiable confirmation
 *    (`externalApplicationId` is the confirmation id);
 *  - REJECTED: the ATS answered and refused (HTTP error / form refusal) -
 *    the submission definitively did NOT happen;
 *  - CHALLENGE_DETECTED: a CAPTCHA/MFA/security challenge was found and the
 *    request was never sent.
 *
 * An adapter THROWS instead when the outcome is UNKNOWN (the request may or
 * may not have reached the ATS, e.g. a network failure mid-request). That
 * maps to AtsError code SUBMISSION_UNCONFIRMED and must never be retried
 * blindly.
 */
export interface AtsSubmissionResult {
  provider: string;
  /** Final page URL around the submission attempt. */
  url: string;
  outcome: AtsSubmissionOutcome;
  /** ATS confirmation/application id (SUBMITTED only). */
  externalApplicationId?: string | null;
  confirmationUrl?: string | null;
  /** HTTP status of the ATS response, when one was received. */
  httpStatus?: number | null;
  /** Present on CHALLENGE_DETECTED. */
  challenge?: AtsSecurityChallenge | null;
  /**
   * Provider confirmation evidence (REAL submissions). Present and required
   * for a verified real submission; the MOCK path instead fills
   * `externalApplicationId` with the mock confirmation id.
   */
  confirmation?: AtsSubmissionConfirmation | null;
  /**
   * Which transport carried the submission request: a documented provider
   * API ('API') or the application form in a browser ('BROWSER'). Recorded
   * for audit so a policy-permitted path fallback is never silent.
   */
  transport?: 'API' | 'BROWSER';
  warnings: string[];
}

/**
 * The generic ATS contract. Providers implement this; higher layers call
 * it through the registry.
 *
 * Inspection/preparation never submit. Submission happens ONLY through the
 * explicit `submitApplication` boundary, only after the core submission
 * safety gate (human approval, approved resume, complete answers) and only
 * against local mock ATS servers (Phase 15A). Adapters never transition an
 * application to SUBMITTED themselves - they report a result and the core
 * workflow owns every state change.
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
  /**
   * Attempt a submission at the MOCK boundary (Phase 15A). Must stop on any
   * security challenge, must never solve/bypass one, and must throw
   * AtsError('SUBMISSION_UNCONFIRMED') when the outcome is unknown.
   */
  submitApplication(context: AtsSubmissionContext): Promise<AtsSubmissionResult>;
}
