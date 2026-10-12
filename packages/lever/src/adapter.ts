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
  MOCK_SUBMISSION_KIND,
  buildMockSubmissionScript,
  challengeKindFor,
  parseMockSubmissionResponse,
  type MockSubmissionResponse,
} from '@jaa/ats';

import { scanLeverPage, type LeverRawField, type LeverRawScan } from './dom-scan';
import { isLeverApplicationUrl, type LeverRecognitionOptions } from './recognition';

/**
 * Phase 9 - Lever ATS adapter.
 *
 * Implements the generic @jaa/ats contract - the exact same one the
 * Greenhouse adapter implements; no provider internals leak into the
 * generic ATS package. All navigation goes through the public
 * @jaa/browser API (SSRF-validated); this package never imports
 * Playwright. Inspection never fills candidate data and never uploads a
 * resume. Submission happens only through the explicit Phase 15A MOCK
 * submission boundary (`submitApplication`), which posts an identifiers-
 * only envelope to a local mock ATS server and stops on any CAPTCHA / MFA /
 * security challenge without ever solving or bypassing it.
 */

export const LEVER_PROVIDER = 'LEVER';

export type LeverAdapterOptions = LeverRecognitionOptions;

/** Semantic categories useful for the later mapping stage. */
export type LeverFieldSemantic =
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
 * Deterministic label/name based classification. Pure heuristics over
 * text - no AI, no candidate data involved.
 */
export function classifyLeverField(
  label: string,
  attrs: Record<string, string>
): LeverFieldSemantic | null {
  const haystack = [label, attrs.name ?? '', attrs.id ?? '', attrs['data-qa'] ?? '']
    .join(' ')
    .toLowerCase();

  if (attrs.accept || attrs.inputType === 'file') {
    if (/cover[\s_-]*letter|motivation/.test(haystack)) return 'cover_letter';
    if (/resume|curriculum|\bcv\b/.test(haystack)) return 'resume';
    return null;
  }
  if (/cover[\s_-]*letter|motivation letter/.test(haystack)) return 'cover_letter';
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

function mapFieldKindToType(raw: LeverRawField): AtsFieldType {
  switch (raw.kind) {
    case 'textarea':
      return 'TEXTAREA';
    case 'select':
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

function toAtsField(raw: LeverRawField): AtsField {
  const semantic = classifyLeverField(raw.label, raw.attributes);
  let type = mapFieldKindToType(raw);

  // Lever renders phone (and similar) as plain text inputs; refine the
  // type from the semantic class when the markup type is ambiguous.
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

export class LeverAtsAdapter implements AtsAdapter {
  readonly provider = LEVER_PROVIDER;
  readonly name = 'Lever';

  constructor(private readonly options: LeverAdapterOptions = {}) {}

  /** Pure, deterministic, no network access. */
  canHandle(url: string): boolean {
    return isLeverApplicationUrl(url, this.options);
  }

  async inspectApplication(context: AtsAdapterContext): Promise<AtsApplicationInspection> {
    if (!this.canHandle(context.url)) {
      throw new AtsError(
        'PAGE_NOT_RECOGNIZED',
        `The URL is not a Lever application URL: ${context.url}`,
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
      // result, not an inspection failure.
      let formFound = true;
      try {
        await context.page.waitForPage({ selector: 'form' });
      } catch {
        formFound = false;
      }

      const scan: LeverRawScan = formFound
        ? await context.page.evaluate(scanLeverPage)
        : {
            formSelector: null,
            formFound: false,
            formAction: null,
            markers: [],
            foreignMarkers: [],
            captcha: null,
            securityChallenge: null,
            fields: [],
          };

      const warnings: string[] = [];
      const blockers: string[] = [];

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

      const looksLever = scan.markers.length > 0;
      const foreign = scan.foreignMarkers.length > 0;
      const hasEmail = scan.fields.some(
        (f) =>
          classifyLeverField(f.label, f.attributes) === 'email' ||
          f.attributes.inputType === 'email'
      );
      const hasName = scan.fields.some((f) => {
        const s = classifyLeverField(f.label, f.attributes);
        return s === 'full_name' || s === 'first_name';
      });
      const applicationShaped = scan.fields.length >= 2 && hasEmail && hasName;

      if (foreign) {
        blockers.push(
          'The page shows another ATS platform markup and is not a Lever application form'
        );
      }

      let isApplicationForm = false;
      if (!scan.formFound) {
        warnings.push('No application form was found on the page');
      } else if (foreign || !(looksLever || applicationShaped)) {
        warnings.push('A form was found but the page does not appear to be a Lever application form');
      } else if (scan.fields.length === 0) {
        warnings.push('The Lever application form has no fillable fields');
      } else {
        isApplicationForm = true;
      }

      return {
        provider: this.provider,
        url: context.page.getCurrentUrl(),
        pageTitle: await context.page.getTitle(),
        isApplicationForm,
        fields: isApplicationForm ? scan.fields.map(toAtsField) : [],
        warnings,
        blockers,
      };
    } catch (err) {
      if (err instanceof AtsError) throw err;
      throw atsErrorFromBrowserError(err, this.provider, context.url);
    }
  }

  /**
   * Phase 15A - MOCK submission boundary.
   *
   * Posts the identifiers-only mock submission envelope to the form's
   * action on the (local mock) ATS and verifies the confirmation. The core
   * workflow guarantees this is only ever reached with a loopback mock ATS
   * target; real applications are structurally out of reach.
   *
   * Safety contract:
   *  - CAPTCHA / MFA / security challenges STOP the submission: reported as
   *    CHALLENGE_DETECTED, never solved, never bypassed;
   *  - errors thrown BEFORE the request is sent mean the submission
   *    definitively did not happen;
   *  - once the request may have reached the ATS, any failure throws
   *    SUBMISSION_UNCONFIRMED (unknown outcome) - callers must never retry
   *    that blindly.
   *  - the envelope carries identifiers and counts only: no answers, no
   *    resume content, no candidate PII.
   */
  async submitApplication(context: AtsSubmissionContext): Promise<AtsSubmissionResult> {
    if (!this.canHandle(context.url)) {
      throw new AtsError(
        'PAGE_NOT_RECOGNIZED',
        `The URL is not a Lever application URL: ${context.url}`,
        this.provider
      );
    }

    // ---- pre-request phase: failures here mean NOTHING was submitted ----
    let scan: LeverRawScan;
    try {
      await context.page.navigate(context.url);
      let formFound = true;
      try {
        await context.page.waitForPage({ selector: 'form' });
      } catch {
        formFound = false;
      }
      scan = formFound
        ? await context.page.evaluate(scanLeverPage)
        : {
            formSelector: null,
            formFound: false,
            formAction: null,
            markers: [],
            foreignMarkers: [],
            captcha: null,
            securityChallenge: null,
            fields: [],
          };
    } catch (err) {
      if (err instanceof AtsError) throw err;
      throw atsErrorFromBrowserError(err, this.provider, context.url);
    }

    const url = context.page.getCurrentUrl();
    const warnings: string[] = [];

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
        warnings: ['No application form was found to submit'],
      };
    }

    // ---- request phase: from here the outcome may be UNKNOWN -----------
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
      response = (await context.page.evaluate(script)) as MockSubmissionResponse;
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
        warnings,
      };
    }
    throw new AtsError('SUBMISSION_UNCONFIRMED', parsed.reason, this.provider);
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
          errors: ['The page does not appear to be a Lever application form'],
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
