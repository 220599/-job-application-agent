import type {
  AtsAdapter,
  AtsAdapterContext,
  AtsApplicationInspection,
  AtsApplicationPreparation,
  AtsField,
  AtsFieldType,
} from '@jaa/ats';
import { AtsError, atsErrorFromBrowserError } from '@jaa/ats';

/**
 * Phase 7 - Mock ATS adapter (TEST FIXTURE ONLY).
 *
 * A deterministic provider implementation used to prove the generic ATS
 * abstraction end-to-end against the local mock application page (same
 * shape as the Phase 6 mock ATS). It lives under tests/fixtures so mock
 * provider logic never leaks into production Greenhouse code (Phase 8).
 *
 * It uses ONLY the public @jaa/browser API (page.navigate / waitForPage /
 * getTitle / evaluate) - no Playwright imports anywhere.
 */

export const MOCK_ATS_PROVIDER = 'MOCK';

/** URLs on loopback are the deterministic mock (tests enable allowPrivateUrls). */
export function isMockAtsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

function mapHtmlInputTypeToFieldType(type: string, tagName: string): AtsFieldType {
  const t = type.toLowerCase();
  if (tagName === 'textarea') return 'TEXTAREA';
  if (tagName === 'select') return 'SELECT';
  switch (t) {
    case 'email':
      return 'EMAIL';
    case 'tel':
      return 'PHONE';
    case 'file':
      return 'FILE';
    case 'date':
      return 'DATE';
    case 'number':
      return 'NUMBER';
    case 'checkbox':
      return 'CHECKBOX';
    case 'radio':
      return 'RADIO';
    case 'password':
      return 'UNKNOWN';
    default:
      return 'TEXT';
  }
}

interface RawDomField {
  tagName: string;
  type: string;
  id: string;
  name: string;
  label: string;
  required: boolean;
  options: { value: string; label: string }[];
}

/** Structure returned by the in-page DOM scan (must stay serializable). */
function scanFormFields(): RawDomField[] {
  const form = document.querySelector('form');
  if (!form) return [];
  const elements = [...form.querySelectorAll('input, select, textarea')];
  return elements
    .filter((el) => {
      const type = (el as HTMLInputElement).type;
      return type !== 'hidden' && type !== 'submit';
    })
    .map((el) => {
      const input = el as HTMLInputElement;
      const id = input.id || input.name || '';
      // <label for="id"> association first, then wrapping label
      const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null;
      const label =
        labelEl?.textContent?.trim() ||
        input.closest('label')?.textContent?.trim() ||
        input.getAttribute('aria-label') ||
        id;
      const options =
        el instanceof HTMLSelectElement
          ? [...el.options].map((o) => ({ value: o.value, label: o.text }))
          : [];
      return {
        tagName: el.tagName.toLowerCase(),
        type: input.type ?? '',
        id,
        name: input.name ?? '',
        label,
        required: input.required,
        options,
      };
    });
}

export class MockAtsAdapter implements AtsAdapter {
  readonly provider = MOCK_ATS_PROVIDER;
  readonly name = 'Mock ATS';

  canHandle(url: string): boolean {
    return isMockAtsUrl(url);
  }

  async inspectApplication(context: AtsAdapterContext): Promise<AtsApplicationInspection> {
    const warnings: string[] = [];
    try {
      // Navigation goes through @jaa/browser -> SSRF validation enforced.
      await context.page.navigate(context.url);
      const pageTitle = await context.page.getTitle();

      // Wait for a form to appear; a 200 page without one is a valid
      // "not recognized" inspection result, not an inspection failure.
      let formFound = true;
      try {
        await context.page.waitForPage({ selector: 'form' });
      } catch {
        formFound = false;
      }
      const rawFields = formFound ? await context.page.evaluate(scanFormFields) : [];
      const fields: AtsField[] = rawFields.map((raw) => ({
        externalFieldId: raw.id || raw.name || null,
        label: raw.label,
        normalizedLabel: raw.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        type: mapHtmlInputTypeToFieldType(raw.type, raw.tagName),
        required: raw.required,
        options: raw.options.length > 0 ? raw.options : null,
        section: null,
        locator: {
          cssSelector: raw.id ? `#${raw.id}` : `[name="${raw.name}"]`,
          attributes: {
            ...(raw.id ? { id: raw.id } : {}),
            ...(raw.name ? { name: raw.name } : {}),
            ...(raw.type ? { type: raw.type } : {}),
            tag: raw.tagName,
          },
        },
      }));

      const isApplicationForm = formFound && fields.length > 0;
      if (!formFound) {
        warnings.push('No application form was found on the page');
      } else if (fields.length === 0) {
        warnings.push('The form has no fillable fields');
      }

      return {
        provider: this.provider,
        url: context.page.getCurrentUrl(),
        pageTitle,
        isApplicationForm,
        fields,
        warnings,
        blockers: [],
      };
    } catch (err) {
      if (err instanceof AtsError) throw err;
      throw atsErrorFromBrowserError(err, this.provider, context.url);
    }
  }

  async prepareApplication(context: AtsAdapterContext): Promise<AtsApplicationPreparation> {
    // Phase 7 scope: inspect only. No field mapping (Phase 9), no answers
    // (Phase 10), no submission (later phases). A recognized form yields
    // NEEDS_REVIEW because nothing fills the fields yet.
    try {
      const inspection = await this.inspectApplication(context);
      if (!inspection.isApplicationForm) {
        return {
          provider: this.provider,
          url: context.url,
          status: 'BLOCKED',
          inspection,
          warnings: inspection.warnings,
          errors: ['The page does not appear to be an application form'],
        };
      }
      return {
        provider: this.provider,
        url: context.url,
        status: 'NEEDS_REVIEW',
        inspection,
        warnings: [...inspection.warnings, 'Fields are not mapped yet (Phase 9)'],
        errors: [],
      };
    } catch (err) {
      const atsError = err instanceof AtsError ? err : atsErrorFromBrowserError(err, this.provider, context.url);
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
