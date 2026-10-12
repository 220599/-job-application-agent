import { readFile } from 'fs/promises';
import { basename } from 'path';

import type {
  AtsAdapter,
  AtsAdapterContext,
  AtsApplicationInspection,
  AtsApplicationPreparation,
  AtsField,
  AtsFieldType,
  AtsSubmissionContext,
  AtsSubmissionResult,
} from '@jaa/ats';
import {
  AtsError,
  atsErrorFromBrowserError,
  isAtsError,
  MOCK_SUBMISSION_KIND,
  buildMockSubmissionScript,
  challengeKindFor,
  parseMockSubmissionResponse,
  type MockSubmissionResponse,
} from '@jaa/ats';

import {
  scanGreenhousePage,
  readOpenDropdownOptions,
  closeOpenDropdown,
  type GreenhouseRawField,
  type GreenhouseRawScan,
} from './dom-scan';
import {
  buildFillGreenhouseFormScript,
  buildSubmitGreenhouseFormScript,
  buildReadGreenhouseConfirmationScript,
  describeGreenhouseRefusal,
  fillGreenhouseComboboxFields,
  interpretGreenhouseConfirmation,
  type GreenhouseInteractionTarget,
  type GreenhouseFieldFillInput,
  type GreenhouseFillResult,
  type GreenhouseSubmitClickResult,
  type GreenhouseConfirmationReading,
} from './real-submission';
import {
  fetchGreenhouseJobBoardQuestions,
  submitGreenhouseJobBoardApplication,
  validateGreenhouseJobBoardApplication,
  type GreenhouseJobBoardQuestion,
} from './job-board-api';
import {
  buildGreenhouseJobBoardInput,
  selectGreenhouseSubmissionPath,
  type GreenhouseJobBoardTarget,
  type GreenhouseJobBoardApiConfig,
} from './job-board-submission';
import {
  isGreenhouseApplicationUrl,
  type GreenhouseRecognitionOptions,
} from './recognition';

/**
 * Phase 8 - Greenhouse ATS adapter.
 *
 * Implements the generic @jaa/ats contract. All navigation goes through
 * the public @jaa/browser API (SSRF-validated); this package never imports
 * Playwright. Inspection never fills candidate data and never uploads a
 * resume. Submission happens only through the explicit submission boundary
 * (`submitApplication`) and has two server-decided modes:
 *
 *  - MOCK (Phase 15A): posts an identifiers-only envelope to a local mock
 *    ATS server - the default and unchanged behavior;
 *  - REAL (Phase 15B): fills and submits the live Greenhouse form, only
 *    under the server's real-submission capability (the core target policy
 *    enforces this before the adapter is ever called);
 *  - JOB_BOARD_API (Phase 15B.2): when the employer-issued Job Board API
 *    key is configured and the URL exposes the documented board/job shape,
 *    the documented non-browser submission endpoint is preferred (no
 *    browser, no CAPTCHA surface). The choice is server-side only and the
 *    fallback to the form path is never silent - see
 *    {@link selectGreenhouseSubmissionPath}.
 *
 * Both modes stop on any CAPTCHA / MFA / security challenge without ever
 * solving or bypassing it, and report UNKNOWN outcomes as unconfirmed
 * rather than guessing.
 */

export const GREENHOUSE_PROVIDER = 'GREENHOUSE';

// Post-submit confirmation polling (REAL mode). The grace period lets the
// submit navigation start before the first read; a rejection verdict must
// additionally stay stable across several reads so a slow success
// transition is never misread as a refusal.
const CONFIRMATION_GRACE_MS = 2_000;
const CONFIRMATION_POLL_MS = 500;
const CONFIRMATION_WINDOW_MS = 20_000;
const CONFIRMATION_STABLE_READS = 3;

// Challenge settle window (REAL mode): challenge scripts (e.g. reCAPTCHA
// Enterprise) load asynchronously and can appear AFTER the form's first
// scan. Before the final pre-submit challenge re-scan the adapter waits up
// to this long for challenge markers to surface, so a late-loading
// challenge still stops the submission before the final submit action.
// Detection only - a challenge is never solved, bypassed, or waited out.
const CHALLENGE_SETTLE_MS = 4_000;
const CHALLENGE_SETTLE_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type GreenhouseAdapterOptions = GreenhouseRecognitionOptions;

/** The adapter's DOM target: fill interactions plus file uploads. */
interface GreenhouseDomTarget extends GreenhouseInteractionTarget {
  setInputFiles(selector: string, files: string[]): Promise<void>;
}

/**
 * Host suffixes allowed for the Greenhouse embed frame on employer-branded
 * wrapper pages (e.g. careers.example.com -> job-boards.greenhouse.io).
 * Enforced by the @jaa/browser frame layer (same-origin frames are always
 * allowed); as defense in depth the frame URL must additionally be a
 * recognized Greenhouse application URL before it is ever entered.
 */
const GREENHOUSE_EMBED_ORIGIN_SUFFIXES = ['greenhouse.io'];

/**
 * Bounded wait for a form to render before the authoritative DOM scan. On
 * wrapper pages (the form lives in an embed frame) the main document never
 * has a form, so this wait must be short - the scan decides, not the wait.
 */
const FORM_RENDER_WAIT_MS = 3_000;

/** Semantic categories useful for the later mapping stage. */
export type GreenhouseFieldSemantic =
  | 'first_name'
  | 'last_name'
  | 'full_name'
  | 'email'
  | 'phone'
  | 'location'
  | 'resume'
  | 'cover_letter'
  | 'linkedin'
  | 'github'
  | 'portfolio'
  | 'work_authorization'
  | 'sponsorship';

/**
 * Deterministic label/name/id based classification. Pure heuristics over
 * text - no AI, no candidate data involved.
 */
export function classifyGreenhouseField(
  label: string,
  attrs: Record<string, string>
): GreenhouseFieldSemantic | null {
  const haystack = [
    label,
    attrs.name ?? '',
    attrs.id ?? '',
    attrs['data-qa'] ?? '',
  ]
    .join(' ')
    .toLowerCase();

  if (attrs.accept || attrs.inputType === 'file') {
    if (/cover[\s_-]*letter|motivation/.test(haystack)) return 'cover_letter';
    if (/resume|curriculum|\bcv\b/.test(haystack)) return 'resume';
    return null;
  }
  if (/sponsor|visa status|immigration sponsor/.test(haystack)) return 'sponsorship';
  if (/authoriz|right to work|legally eligible|work permit|eligible to work/.test(haystack)) {
    return 'work_authorization';
  }
  if (/linkedin/.test(haystack)) return 'linkedin';
  if (/github/.test(haystack)) return 'github';
  if (/portfolio|personal (web)?site|web[\s_-]*site/.test(haystack)) return 'portfolio';
  if (/(^|[^a-z])e-?mail([^a-z]|$)/.test(haystack) || attrs.autocomplete === 'email') return 'email';
  if (/phone|telephone|mobile|cell/.test(haystack) || attrs.autocomplete === 'tel') return 'phone';
  if (/first[\s_-]*name/.test(haystack) && !/full/.test(haystack)) return 'first_name';
  if (/last[\s_-]*name|family[\s_-]*name|surname/.test(haystack)) return 'last_name';
  if (/full[\s_-]*name|(^|[^a-z])name([^a-z]|$)|applicant name/.test(haystack)) return 'full_name';
  if (/location|city|address|where are you based/.test(haystack)) return 'location';
  return null;
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function mapFieldKindToType(raw: GreenhouseRawField): AtsFieldType {
  switch (raw.kind) {
    case 'textarea':
      return 'TEXTAREA';
    case 'select':
    case 'combobox':
      return 'SELECT';
    case 'radio-group':
      return 'RADIO';
    case 'checkbox-group':
    case 'checkbox':
      return 'CHECKBOX';
    case 'file':
      return 'FILE';
    default: {
      const t = (raw.attributes.inputType ?? 'text').toLowerCase();
      if (t === 'email') return 'EMAIL';
      if (t === 'tel') return 'PHONE';
      if (t === 'date') return 'DATE';
      if (t === 'number') return 'NUMBER';
      return 'TEXT';
    }
  }
}

function toAtsField(raw: GreenhouseRawField): AtsField {
  const semantic = classifyGreenhouseField(raw.label, raw.attributes);
  let type = mapFieldKindToType(raw);

  // Greenhouse commonly renders email/phone as plain text inputs; refine
  // the type from the semantic class when the markup type is ambiguous.
  if (type === 'TEXT' && semantic === 'email') type = 'EMAIL';
  if (type === 'TEXT' && semantic === 'phone') type = 'PHONE';

  const isGroup = raw.kind === 'radio-group' || raw.kind === 'checkbox-group';
  // Groups are identified by their shared name (the first option's id is
  // option-specific); single fields prefer their element id.
  const externalFieldId = isGroup
    ? raw.attributes.name || raw.attributes.id || null
    : raw.attributes.id || raw.attributes.name || null;
  return {
    externalFieldId,
    label: raw.label,
    normalizedLabel: normalizeLabel(raw.label),
    type,
    required: raw.required,
    options: raw.options && raw.options.length > 0 ? raw.options : null,
    section: raw.section,
    locator: {
      cssSelector: raw.cssSelector,
      attributes: {
        ...raw.attributes,
        ...(semantic ? { semantic } : {}),
      },
    },
  };
}

export class GreenhouseAtsAdapter implements AtsAdapter {
  readonly provider = GREENHOUSE_PROVIDER;
  readonly name = 'Greenhouse';

  constructor(private readonly options: GreenhouseAdapterOptions = {}) {}

  /** Pure, deterministic, no network access. */
  canHandle(url: string): boolean {
    return isGreenhouseApplicationUrl(url, this.options);
  }

  async inspectApplication(context: AtsAdapterContext): Promise<AtsApplicationInspection> {
    if (!this.canHandle(context.url)) {
      throw new AtsError(
        'PAGE_NOT_RECOGNIZED',
        `The URL is not a Greenhouse application URL: ${context.url}`,
        this.provider
      );
    }

    try {
      // Navigation goes through @jaa/browser -> SSRF validation enforced.
      await context.page.navigate(context.url);
    } catch (err) {
      if (err instanceof AtsError) throw err;
      throw atsErrorFromBrowserError(err, this.provider, context.url);
    }

    try {
      // A page without any form is a valid "not recognized" inspection
      // result, not an inspection failure. On custom-domain boards the form
      // may live in a Greenhouse embed frame - resolveFormTarget handles
      // that through the narrow, SSRF-safe frame layer.
      const { target, scan, embeddedInFrame } = await this.resolveFormTarget(context);

      const warnings: string[] = [];
      const blockers: string[] = [];
      if (embeddedInFrame) {
        warnings.push(
          'The application form is hosted in an embedded frame; it was inspected in-frame and never outside it'
        );
      }

      if (scan.captcha) {
        warnings.push(
          `A ${scan.captcha} CAPTCHA is present on the form; it will require human interaction and is never bypassed`
        );
      }
      if (scan.securityChallenge) {
        warnings.push(
          `A ${scan.securityChallenge} security challenge is present on the page; submission stops immediately and the challenge is never solved or bypassed`
        );
      }

      const looksGreenhouse = scan.markers.length > 0;
      const foreign = scan.foreignMarkers.length > 0;
      const hasEmail = scan.fields.some(
        (f) =>
          classifyGreenhouseField(f.label, f.attributes) === 'email' ||
          f.attributes.inputType === 'email'
      );
      const hasName = scan.fields.some((f) => {
        const s = classifyGreenhouseField(f.label, f.attributes);
        return s === 'full_name' || s === 'first_name';
      });
      const applicationShaped = scan.fields.length >= 2 && hasEmail && hasName;

      if (foreign) {
        blockers.push(
          'The page shows another ATS platform markup and is not a Greenhouse application form'
        );
      }

      let isApplicationForm = false;
      if (!scan.formFound) {
        warnings.push('No application form was found on the page');
      } else if (foreign || !(looksGreenhouse || applicationShaped)) {
        warnings.push(
          'A form was found but the page does not appear to be a Greenhouse application form'
        );
      } else if (scan.fields.length === 0) {
        warnings.push('The Greenhouse application form has no fillable fields');
      } else {
        isApplicationForm = true;
      }

      let fields: AtsField[] = [];
      if (isApplicationForm) {
        fields = scan.fields.map(toAtsField);
        // Greenhouse's custom dropdowns (react-select) only expose their
        // options while open: enumerate them best-effort, read-only.
        await this.captureComboboxOptions(target, scan.fields, fields, warnings);
      }

      return {
        provider: this.provider,
        url: context.page.getCurrentUrl(),
        pageTitle: await context.page.getTitle(),
        isApplicationForm,
        fields,
        warnings,
        blockers,
      };
    } catch (err) {
      if (err instanceof AtsError) throw err;
      throw atsErrorFromBrowserError(err, this.provider, context.url);
    }
  }

  /**
   * Best-effort option enumeration for react-select comboboxes: open the
   * dropdown, read the rendered options, close it again without selecting
   * anything. Failures degrade to `options: null` plus a warning.
   * `rawFields` and `fields` are parallel arrays (1:1 mapping).
   */
  private async captureComboboxOptions(
    target: GreenhouseDomTarget,
    rawFields: GreenhouseRawField[],
    fields: AtsField[],
    warnings: string[]
  ): Promise<void> {
    for (let i = 0; i < rawFields.length; i += 1) {
      const raw = rawFields[i];
      const field = fields[i];
      if (raw.kind !== 'combobox') continue;
      const selector = field.locator?.cssSelector;
      if (!selector) continue;
      try {
        await target.click(selector);
        try {
          await target.waitForSelector('[role="option"]', 1500);
        } catch {
          // No options rendered - leave the field without options.
        }
        const options = await target.evaluate(readOpenDropdownOptions);
        if (options.length > 0) field.options = options;
        await target.evaluate(closeOpenDropdown);
      } catch {
        warnings.push(
          `Could not enumerate options for "${field.label}"; the field is recorded without options`
        );
        await target.evaluate(closeOpenDropdown).catch(() => undefined);
      }
    }
  }

  /**
   * Locate the application form. The main document is scanned first; when
   * it has no form (custom-domain boards hosting the form in a Greenhouse
   * embed frame) a frame lookup runs through the narrow, SSRF-safe
   * @jaa/browser frame layer: every frame URL passes the navigation SSRF
   * policy, same-origin frames only unless the origin is explicitly allowed
   * for this provider, and - defense in depth - the frame URL must be a
   * recognized Greenhouse application URL before it is ever entered. When
   * no form exists anywhere, the main-document scan is returned unchanged
   * (a valid "not recognized" inspection result).
   */
  private async resolveFormTarget(
    context: AtsAdapterContext
  ): Promise<{ target: GreenhouseDomTarget; scan: GreenhouseRawScan; embeddedInFrame: boolean }> {
    const emptyScan: GreenhouseRawScan = {
      formSelector: null,
      formFound: false,
      formAction: null,
      markers: [],
      foreignMarkers: [],
      captcha: null,
      securityChallenge: null,
      fields: [],
    };
    try {
      await context.page.waitForPage({ selector: 'form', timeoutMs: FORM_RENDER_WAIT_MS });
    } catch {
      // No form appeared in time - the scan below is authoritative.
    }
    let mainScan: GreenhouseRawScan = emptyScan;
    try {
      mainScan = await context.page.evaluate(scanGreenhousePage);
    } catch {
      // The document is unreachable - treat it as a page without a form.
    }
    if (mainScan.formFound) {
      return { target: context.page, scan: mainScan, embeddedInFrame: false };
    }

    const frame = await context.page.frameContaining('form', {
      allowedOriginSuffixes: GREENHOUSE_EMBED_ORIGIN_SUFFIXES,
      timeoutMs: 5_000,
    });
    if (frame && isGreenhouseApplicationUrl(frame.url(), this.options)) {
      const frameScan = await frame.evaluate(scanGreenhousePage);
      if (frameScan.formFound) {
        return { target: frame, scan: frameScan, embeddedInFrame: true };
      }
    }
    return { target: context.page, scan: mainScan, embeddedInFrame: false };
  }

  /**
   * Submission boundary (Phase 15A MOCK, Phase 15B controlled REAL).
   *
   * MOCK: posts the identifiers-only mock submission envelope to the form's
   * action on the (local mock) ATS and verifies the confirmation. The core
   * workflow guarantees this is only ever reached with a loopback mock ATS
   * target.
   *
   * REAL: fills and submits the live Greenhouse form from the prepared
   * answers (see {@link GreenhouseAtsAdapter.submitRealGreenhouseForm}),
   * only under the server's real-submission capability.
   *
   * Safety contract (both modes):
   *  - CAPTCHA / MFA / security challenges STOP the submission: reported as
   *    CHALLENGE_DETECTED, never solved, never bypassed;
   *  - errors thrown BEFORE the request is sent mean the submission
   *    definitively did not happen;
   *  - once the request may have reached the ATS, any failure throws
   *    SUBMISSION_UNCONFIRMED (unknown outcome) - callers must never retry
   *    that blindly.
   *  - the MOCK envelope carries identifiers and counts only: no answers,
   *    no resume content, no candidate PII.
   */
  async submitApplication(context: AtsSubmissionContext): Promise<AtsSubmissionResult> {
    if (!this.canHandle(context.url)) {
      throw new AtsError(
        'PAGE_NOT_RECOGNIZED',
        `The URL is not a Greenhouse application URL: ${context.url}`,
        this.provider
      );
    }

    // Phase 15B.2 - server-side path selection. The documented Job Board
    // API is preferred when the employer authorized it (API key) and the
    // URL exposes the documented board/job shape. When it is unavailable
    // the form path runs under the EXISTING core policy (never relaxed
    // here) and the fallback is recorded - never silent.
    const pathSelection = selectGreenhouseSubmissionPath({
      url: context.url,
      submissionMode: context.submissionMode,
    });
    if (pathSelection.path === 'JOB_BOARD_API') {
      return await this.submitViaJobBoardApi(context, pathSelection.target, pathSelection.config);
    }

    // ---- pre-request phase: failures here mean NOTHING was submitted ----
    let scan: GreenhouseRawScan;
    let target: GreenhouseDomTarget;
    try {
      await context.page.navigate(context.url);
      const resolved = await this.resolveFormTarget(context);
      scan = resolved.scan;
      target = resolved.target;
    } catch (err) {
      if (err instanceof AtsError) throw err;
      throw atsErrorFromBrowserError(err, this.provider, context.url);
    }

    const url = context.page.getCurrentUrl();
    const warnings: string[] = [pathSelection.reason];

    // Security challenges stop submission immediately - never solved.
    if (scan.captcha) {
      return {
        provider: this.provider,
        url,
        outcome: 'CHALLENGE_DETECTED',
        externalApplicationId: null,
        confirmationUrl: null,
        httpStatus: null,
        challenge: { kind: challengeKindFor(scan.captcha), detail: scan.captcha },
        transport: 'BROWSER',
        warnings,
      };
    }
    if (scan.securityChallenge) {
      return {
        provider: this.provider,
        url,
        outcome: 'CHALLENGE_DETECTED',
        externalApplicationId: null,
        confirmationUrl: null,
        httpStatus: null,
        challenge: {
          kind: challengeKindFor(scan.securityChallenge),
          detail: scan.securityChallenge,
        },
        transport: 'BROWSER',
        warnings,
      };
    }

    if (!scan.formFound || !scan.formSelector) {
      // Definitive: there is no form to submit, so nothing was sent.
      return {
        provider: this.provider,
        url,
        outcome: 'REJECTED',
        externalApplicationId: null,
        confirmationUrl: null,
        httpStatus: null,
        challenge: null,
        transport: 'BROWSER',
        warnings: ['No application form was found to submit'],
      };
    }

    // ---- request phase: from here the outcome may be UNKNOWN -----------
    // Phase 15B - REAL mode fills and submits the live Greenhouse form. It
    // is only reachable under the server's real-submission capability (the
    // core workflow enforces this before calling the adapter). MOCK mode
    // keeps the Phase 15A identifiers-only envelope below, unchanged.
    if (context.submissionMode === 'REAL') {
      return await this.submitRealGreenhouseForm(context, scan, url, warnings, target);
    }

    const script = buildMockSubmissionScript(scan.formSelector, {
      kind: MOCK_SUBMISSION_KIND,
      applicationId: context.applicationId ?? '',
      submissionAttemptId: context.submissionAttemptId,
      provider: this.provider,
      fieldCount: context.fieldCount,
      requiredAnswerCount: context.requiredAnswerCount,
    });

    let response: MockSubmissionResponse;
    try {
      response = (await target.evaluate(script)) as MockSubmissionResponse;
    } catch (err) {
      // The request may have gone out before the failure - outcome unknown.
      throw new AtsError(
        'SUBMISSION_UNCONFIRMED',
        `The submission request outcome is unknown: ${err instanceof Error ? err.message : String(err)}`,
        this.provider,
        err
      );
    }

    const parsed = parseMockSubmissionResponse(response);
    if (parsed.kind === 'SUBMITTED') {
      return {
        provider: this.provider,
        url,
        outcome: 'SUBMITTED',
        externalApplicationId: parsed.confirmationId,
        confirmationUrl: url,
        httpStatus: parsed.httpStatus,
        challenge: null,
        transport: 'BROWSER',
        warnings,
      };
    }
    if (parsed.kind === 'REJECTED') {
      return {
        provider: this.provider,
        url,
        outcome: 'REJECTED',
        externalApplicationId: null,
        confirmationUrl: null,
        httpStatus: parsed.httpStatus,
        challenge: null,
        transport: 'BROWSER',
        warnings,
      };
    }
    throw new AtsError('SUBMISSION_UNCONFIRMED', parsed.reason, this.provider);
  }

  /**
   * Phase 15B.2 - documented, employer-authorized Job Board API submission
   * (NON-BROWSER). The employer issued a Job Board API key for this
   * integration, so the documented submission endpoint is used instead of
   * the web form. This path carries no browser-based CAPTCHA surface at all
   * (Greenhouse's spam protection lives on the embedded web form), so the
   * CAPTCHA policy is untouched: challenges are still detected and never
   * solved on every browser path.
   *
   * Safety contract:
   *  - every failure BEFORE the submission request (unreadable question
   *    list, unreadable approved resume, missing/ungrounded required
   *    answers) is a KNOWN pre-send failure: nothing was transmitted;
   *  - exactly ONE submission request is issued - the Job Board API has no
   *    idempotency support, so nothing here ever retries;
   *  - a thrown SUBMISSION_UNCONFIRMED always means the request may have
   *    reached the provider: UNKNOWN outcome, never retried blindly;
   *  - success is reported from real provider evidence only: the provider
   *    reference when one is exposed (PROVIDER_ID), otherwise the
   *    documented endpoint's own 2xx success signal (HTTP_ACCEPTED) - the
   *    response body schema is undocumented, so no id is ever invented;
   *  - diagnostics name fields/labels only: answer values, the API key and
   *    file contents never appear in results, warnings, or error messages.
   */
  private async submitViaJobBoardApi(
    context: AtsSubmissionContext,
    target: GreenhouseJobBoardTarget,
    config: GreenhouseJobBoardApiConfig
  ): Promise<AtsSubmissionResult> {
    const baseUrl = config.baseUrl;
    const warnings: string[] = [];

    // 1. Read-only documented question list (public GET). It grounds the
    //    field mapping and the mandated client-side required validation.
    let questions: GreenhouseJobBoardQuestion[];
    try {
      questions = await fetchGreenhouseJobBoardQuestions({
        boardToken: target.boardToken,
        jobPostId: target.jobPostId,
        ...(baseUrl ? { baseUrl } : {}),
      });
    } catch (err) {
      if (isAtsError(err)) {
        // The provider answered the read request with an error - the job
        // post may be gone. Known pre-send failure: nothing was submitted.
        throw new AtsError(
          'SUBMISSION_FAILED',
          `The Job Board API question list could not be read (nothing was submitted): ${err.message}`,
          this.provider,
          err
        );
      }
      // Network failure on a READ request - transient, and nothing was
      // sent: a bounded retry of this attempt is safe.
      throw new AtsError(
        'PROVIDER_UNAVAILABLE',
        `The Job Board API question list could not be fetched (nothing was submitted): ${
          err instanceof Error ? err.message : String(err)
        }`,
        this.provider,
        err
      );
    }

    // 2. The approved resume - the only file ever sent, and only ever the
    //    approved one. An unreadable file is a pre-send failure.
    let resumeContentBase64: string | null = null;
    let resumeFileName: string | null = null;
    if (context.resumeFile) {
      try {
        const buffer = await readFile(context.resumeFile);
        if (buffer.length === 0) throw new Error('the approved resume file is empty');
        resumeContentBase64 = buffer.toString('base64');
        resumeFileName = basename(context.resumeFile);
      } catch (err) {
        throw new AtsError(
          'SUBMISSION_FAILED',
          `The approved resume file could not be read (nothing was submitted): ${
            err instanceof Error ? err.message : String(err)
          }`,
          this.provider,
          err
        );
      }
    }

    // 3. Map the approved answers onto the documented field names (never
    //    fabricated) and validate everything BEFORE any request is sent.
    const build = buildGreenhouseJobBoardInput({
      questions,
      fills: context.fieldFills ?? [],
      resumeContentBase64,
      resumeFileName,
    });
    warnings.push(...build.warnings);
    const violations = [
      ...build.violations,
      ...validateGreenhouseJobBoardApplication(build.input),
    ];
    if (violations.length > 0) {
      // Documented client-side required validation refused the attempt
      // BEFORE anything was sent ("Greenhouse will not reject applications
      // that are missing required fields" - so this gate is mandatory).
      // Field names and problems only - never answer values.
      throw new AtsError(
        'SUBMISSION_FAILED',
        `The application was not sent: ${violations
          .map((violation) => `${violation.field} ${violation.problem}`)
          .join('; ')}`,
        this.provider
      );
    }

    // 4. Exactly ONE documented submission request (no retry anywhere).
    const result = await submitGreenhouseJobBoardApplication({
      apiKey: config.apiKey,
      boardToken: target.boardToken,
      jobPostId: target.jobPostId,
      input: build.input,
      ...(baseUrl ? { baseUrl } : {}),
    });

    if (result.kind === 'ACCEPTED') {
      const reference = result.reference;
      return {
        provider: this.provider,
        url: context.url,
        outcome: 'SUBMITTED',
        externalApplicationId: reference,
        confirmationUrl: null,
        httpStatus: result.httpStatus,
        challenge: null,
        confirmation: {
          method: reference ? 'PROVIDER_ID' : 'HTTP_ACCEPTED',
          reference,
          url: null,
        },
        transport: 'API',
        warnings,
      };
    }
    if (result.kind === 'REFUSED') {
      if (result.httpStatus === 401 || result.httpStatus === 403) {
        // The provider refused the CONFIGURED CREDENTIALS - the application
        // itself was never evaluated and nothing was recorded. A known
        // pre-send failure: fix the employer-issued key, never auto-retry.
        throw new AtsError(
          'SUBMISSION_FAILED',
          `The Job Board API refused the configured employer credentials (HTTP ${result.httpStatus}); nothing was submitted - verify the employer-issued Job Board API key`,
          this.provider
        );
      }
      // The provider answered and refused the application (4xx): a
      // definitive refusal - nothing was submitted.
      return {
        provider: this.provider,
        url: context.url,
        outcome: 'REJECTED',
        externalApplicationId: null,
        confirmationUrl: null,
        httpStatus: result.httpStatus,
        challenge: null,
        transport: 'API',
        warnings: [...warnings, result.detail],
      };
    }

    // BLOCKED: client-side validation refused before any request.
    throw new AtsError(
      'SUBMISSION_FAILED',
      `The application was not sent: ${result.violations
        .map((violation) => `${violation.field} ${violation.problem}`)
        .join('; ')}`,
      this.provider
    );
  }

  /**
   * Phase 15B - controlled REAL Greenhouse submission: fill the live form
   * from the prepared answers, re-check for security challenges, submit
   * through the form's own submit control, and verify REAL provider
   * confirmation. Only reachable under the server's real-submission
   * capability - the core target policy decides the mode and refuses any
   * real target without it.
   *
   * Safety contract:
   *  - every failure BEFORE the submit control is activated means the
   *    application was definitively NOT submitted;
   *  - CAPTCHA / MFA / security challenges are re-scanned after filling and
   *    stop the submission immediately - never solved, never bypassed;
   *  - once the submit control is activated, any unresolvable failure
   *    throws SUBMISSION_UNCONFIRMED (unknown outcome), never a blind retry;
   *  - success is reported only from real provider evidence (an explicit
   *    application-received confirmation page, or a provider reference) -
   *    never fabricated;
   *  - prepared answers stay in memory and the live form only: never
   *    logged, never persisted to events or queue payloads.
   */
  private async submitRealGreenhouseForm(
    context: AtsSubmissionContext,
    scan: GreenhouseRawScan,
    url: string,
    warnings: string[],
    target: GreenhouseDomTarget
  ): Promise<AtsSubmissionResult> {
    // ---- fill phase: nothing has been submitted yet -------------------
    const filledSelectors = new Set<string>();
    try {
      const prepared: GreenhouseFieldFillInput[] = (context.fieldFills ?? [])
        .filter((fill) => fill.fieldType !== 'FILE')
        .map((fill) => ({
          cssSelector: fill.locator?.cssSelector ?? null,
          fieldType: fill.fieldType,
          value: fill.value,
          options: fill.options ?? null,
        }));
      const comboboxSelectors = new Set(
        scan.fields.filter((f) => f.kind === 'combobox').map((f) => f.cssSelector)
      );
      const comboboxFills = prepared.filter(
        (f) => f.cssSelector !== null && comboboxSelectors.has(f.cssSelector)
      );
      const valueFills = prepared.filter(
        (f) => f.cssSelector === null || !comboboxSelectors.has(f.cssSelector)
      );

      // React Select fields: open the menu, read the LIVE options, and
      // select only an option grounded in the approved answer. Anything
      // else is recorded as missed and never guessed.
      const unfilledUnsafe: string[] = [];
      if (comboboxFills.length > 0) {
        const comboboxResult = await fillGreenhouseComboboxFields(target, comboboxFills);
        for (const selector of comboboxResult.filled) filledSelectors.add(selector);
        unfilledUnsafe.push(...comboboxResult.missed);
      }
      if (valueFills.length > 0) {
        const fillResult = (await target.evaluate(
          buildFillGreenhouseFormScript(valueFills)
        )) as GreenhouseFillResult;
        for (const selector of fillResult.filled) filledSelectors.add(selector);
        if (fillResult.missed.length > 0) {
          warnings.push(
            `${fillResult.missed.length} prepared field value(s) could not be matched to the live form and were not filled`
          );
        }
      }
      if (unfilledUnsafe.length > 0) {
        warnings.push(
          `${unfilledUnsafe.length} dropdown field(s) had no live option grounded in the approved answers and were left unfilled (never guessed)`
        );
      }
      await this.uploadResumeFile(context, scan, warnings, target);
    } catch (err) {
      if (err instanceof AtsError) throw err;
      // Filling never sends the application: a fill failure is definitive.
      throw new AtsError(
        'SUBMISSION_FAILED',
        `Filling the Greenhouse form failed before anything was submitted: ${err instanceof Error ? err.message : String(err)}`,
        this.provider,
        err
      );
    }

    // ---- challenge settle + re-scan -----------------------------------
    // Challenge scripts (e.g. reCAPTCHA Enterprise) load asynchronously
    // and may appear after the first scan. Wait briefly so a late-loading
    // challenge is STILL detected before the final submit action - then
    // stop immediately if one is present. Never solved, never bypassed.
    await this.settleChallenges(target);
    let rescan: GreenhouseRawScan;
    try {
      rescan = await target.evaluate(scanGreenhousePage);
    } catch (err) {
      throw new AtsError(
        'SUBMISSION_FAILED',
        `Re-checking the form before submission failed (nothing was submitted): ${err instanceof Error ? err.message : String(err)}`,
        this.provider,
        err
      );
    }
    const fieldStates = scan.fields.map((f) => ({
      label: f.label,
      type: mapFieldKindToType(f),
      required: f.required,
      filled: filledSelectors.has(f.cssSelector),
    }));
    if (rescan.captcha || rescan.securityChallenge) {
      const detail = rescan.captcha ?? rescan.securityChallenge ?? 'security-challenge';
      const challenge = { kind: challengeKindFor(detail), detail };
      // PII-free diagnostics: which required questions and which challenge
      // blocked progress - labels and types only, never candidate answers.
      warnings.push(...describeGreenhouseRefusal(fieldStates, challenge));
      return {
        provider: this.provider,
        url,
        outcome: 'CHALLENGE_DETECTED',
        externalApplicationId: null,
        confirmationUrl: null,
        httpStatus: null,
        challenge,
        transport: 'BROWSER',
        warnings,
      };
    }

    // ---- submit phase: from here the outcome may be UNKNOWN -----------
    let click: GreenhouseSubmitClickResult;
    try {
      click = (await target.evaluate(
        buildSubmitGreenhouseFormScript(rescan.formSelector ?? scan.formSelector)
      )) as GreenhouseSubmitClickResult;
    } catch (err) {
      // The click may have triggered navigation that tore the page down
      // mid-evaluation - the request may have gone out. Unknown outcome.
      throw new AtsError(
        'SUBMISSION_UNCONFIRMED',
        `The submission click outcome is unknown: ${err instanceof Error ? err.message : String(err)}`,
        this.provider,
        err
      );
    }
    if (!click || click.method === 'none') {
      // No submit control was activated: nothing was sent (definitive).
      throw new AtsError(
        'SUBMISSION_FAILED',
        'No submit control was found on the Greenhouse form; nothing was submitted',
        this.provider
      );
    }

    // ---- confirmation phase: only real provider evidence counts -------
    const reading = await this.awaitGreenhouseConfirmation(target);
    const verdict = interpretGreenhouseConfirmation(reading);
    const finalUrl = reading?.url || url;

    if (verdict === 'CONFIRMED' && reading) {
      const reference =
        reading.reference && reading.reference.trim().length > 0
          ? reading.reference.trim()
          : null;
      return {
        provider: this.provider,
        url: reading.url || finalUrl,
        outcome: 'SUBMITTED',
        externalApplicationId: reference,
        confirmationUrl: reading.url || finalUrl,
        httpStatus: null,
        challenge: null,
        confirmation: {
          method: reference ? 'PROVIDER_ID' : 'SUCCESS_PAGE',
          reference,
          url: reading.url || finalUrl,
        },
        transport: 'BROWSER',
        warnings,
      };
    }
    if (verdict === 'REJECTED') {
      // The form actively refused the submission (visible validation or
      // required errors): definitive - the application was NOT submitted.
      // Diagnostics explain WHICH required questions blocked progress -
      // labels and types only, never candidate answers.
      warnings.push(
        'The form actively refused the submission (visible validation errors); nothing was submitted'
      );
      warnings.push(...describeGreenhouseRefusal(fieldStates, null));
      return {
        provider: this.provider,
        url: finalUrl,
        outcome: 'REJECTED',
        externalApplicationId: null,
        confirmationUrl: null,
        httpStatus: null,
        challenge: null,
        transport: 'BROWSER',
        warnings,
      };
    }
    // UNKNOWN: the request may or may not have been accepted. Never
    // retried blindly - the caller records the unknown outcome.
    throw new AtsError(
      'SUBMISSION_UNCONFIRMED',
      'The submission completed without a verifiable confirmation; the outcome is unknown and must never be retried blindly',
      this.provider
    );
  }

  /**
   * Brief bounded wait for late-loading challenge markers (e.g. reCAPTCHA
   * Enterprise) before the final pre-submit challenge re-scan. Detection
   * only: the adapter never solves or bypasses a challenge and never waits
   * one OUT - as soon as a challenge is present the flow stops.
   */
  private async settleChallenges(target: GreenhouseDomTarget): Promise<void> {
    const deadline = Date.now() + CHALLENGE_SETTLE_MS;
    while (Date.now() < deadline) {
      try {
        const scan = await target.evaluate(scanGreenhousePage);
        if (scan.captcha || scan.securityChallenge) return;
      } catch {
        // The page may be mid-render; keep polling until the window ends.
      }
      await sleep(CHALLENGE_SETTLE_POLL_MS);
    }
  }

  /**
   * Upload the approved resume file to the form's FILE fields (REAL mode).
   * Only the approved resume is ever uploaded; any other file field is left
   * empty with a warning. A missing file is a fill-phase failure (nothing
   * has been submitted yet).
   */
  private async uploadResumeFile(
    context: AtsSubmissionContext,
    scan: GreenhouseRawScan,
    warnings: string[],
    target: GreenhouseDomTarget
  ): Promise<void> {
    for (const raw of scan.fields) {
      if (raw.kind !== 'file') continue;
      const semantic = classifyGreenhouseField(raw.label, raw.attributes);
      if (semantic === 'resume' && context.resumeFile) {
        await target.setInputFiles(raw.cssSelector, [context.resumeFile]);
        continue;
      }
      warnings.push(
        semantic === 'resume'
          ? 'The resume file field was left empty: no approved resume file is available'
          : `The file field "${raw.label}" was left empty: no approved file is available for it`
      );
    }
  }

  /**
   * Poll the post-submit page for real provider confirmation evidence.
   * CONFIRMED is accepted as soon as it is observed; a REJECTED verdict
   * must stay stable across several reads so a slow success transition is
   * never misread as a refusal. Returns the last reading (possibly null) if
   * the observation window ends without a stable verdict.
   */
  private async awaitGreenhouseConfirmation(
    target: GreenhouseDomTarget
  ): Promise<GreenhouseConfirmationReading | null> {
    const deadline = Date.now() + CONFIRMATION_WINDOW_MS;
    await sleep(CONFIRMATION_GRACE_MS);
    let last: GreenhouseConfirmationReading | null = null;
    let stableRefusals = 0;
    while (Date.now() < deadline) {
      let reading: GreenhouseConfirmationReading | null = null;
      try {
        reading = (await target.evaluate(
          buildReadGreenhouseConfirmationScript()
        )) as GreenhouseConfirmationReading;
      } catch {
        // The page is mid-navigation; read again once it settles.
        reading = null;
      }
      if (reading) {
        last = reading;
        const verdict = interpretGreenhouseConfirmation(reading);
        if (verdict === 'CONFIRMED') return reading;
        if (verdict === 'REJECTED') {
          stableRefusals += 1;
          if (stableRefusals >= CONFIRMATION_STABLE_READS) return reading;
        } else {
          stableRefusals = 0;
        }
      }
      await sleep(CONFIRMATION_POLL_MS);
    }
    return last;
  }

  /**
   * Preparation stops at the inspection boundary (FORM_INSPECTED later in
   * the workflow): no mapping, no answers, no uploads, no submission.
   */
  async prepareApplication(context: AtsAdapterContext): Promise<AtsApplicationPreparation> {
    try {
      const inspection = await this.inspectApplication(context);
      if (!inspection.isApplicationForm) {
        return {
          provider: this.provider,
          url: context.url,
          status: 'BLOCKED',
          inspection,
          warnings: inspection.warnings,
          errors: ['The page does not appear to be a Greenhouse application form'],
        };
      }
      return {
        provider: this.provider,
        url: context.url,
        status: 'NEEDS_REVIEW',
        inspection,
        warnings: [
          ...inspection.warnings,
          'Fields were inspected but are not mapped to candidate data yet; ready for the mapping/review stage',
        ],
        errors: [],
      };
    } catch (err) {
      const atsError =
        err instanceof AtsError ? err : atsErrorFromBrowserError(err, this.provider, context.url);
      return {
        provider: this.provider,
        url: context.url,
        status: 'FAILED',
        inspection: null,
        warnings: [],
        errors: [`${atsError.code}: ${atsError.message}`],
      };
    }
  }
}
