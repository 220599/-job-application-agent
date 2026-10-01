import type {
  AtsAdapter,
  AtsAdapterContext,
  AtsApplicationInspection,
  AtsApplicationPreparation,
  AtsField,
  AtsFieldType,
} from '@jaa/ats';
import { AtsError, atsErrorFromBrowserError } from '@jaa/ats';

import {
  scanGreenhousePage,
  readOpenDropdownOptions,
  closeOpenDropdown,
  type GreenhouseRawField,
  type GreenhouseRawScan,
} from './dom-scan';
import {
  isGreenhouseApplicationUrl,
  type GreenhouseRecognitionOptions,
} from './recognition';

/**
 * Phase 8 - Greenhouse ATS adapter.
 *
 * Implements the generic @jaa/ats contract. All navigation goes through
 * the public @jaa/browser API (SSRF-validated); this package never imports
 * Playwright. Inspection only: it never fills candidate data, never
 * uploads a resume and never submits an application.
 */

export const GREENHOUSE_PROVIDER = 'GREENHOUSE';

export type GreenhouseAdapterOptions = GreenhouseRecognitionOptions;

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
      // result, not an inspection failure.
      let formFound = true;
      try {
        await context.page.waitForPage({ selector: 'form' });
      } catch {
        formFound = false;
      }

      const scan: GreenhouseRawScan = formFound
        ? await context.page.evaluate(scanGreenhousePage)
        : {
            formSelector: null,
            formFound: false,
            markers: [],
            foreignMarkers: [],
            captcha: null,
            fields: [],
          };

      const warnings: string[] = [];
      const blockers: string[] = [];

      if (scan.captcha) {
        warnings.push(
          `A ${scan.captcha} CAPTCHA is present on the form; it will require human interaction and is never bypassed`
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
        await this.captureComboboxOptions(context, scan.fields, fields, warnings);
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
    context: AtsAdapterContext,
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
        await context.page.click(selector);
        try {
          await context.page.waitForSelector('[role="option"]', 1500);
        } catch {
          // No options rendered - leave the field without options.
        }
        const options = await context.page.evaluate(readOpenDropdownOptions);
        if (options.length > 0) field.options = options;
        await context.page.evaluate(closeOpenDropdown);
      } catch {
        warnings.push(
          `Could not enumerate options for "${field.label}"; the field is recorded without options`
        );
        await context.page.evaluate(closeOpenDropdown).catch(() => undefined);
      }
    }
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
