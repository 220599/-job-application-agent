/**
 * Phase 15C - Lever Apply API orchestration glue.
 *
 * Connects the documented, employer-authorized Lever Apply API client
 * (apply-api.ts) to the generic @jaa/ats submission boundary. Vendor
 * specifics live HERE (and in the adapter); generic submission policy stays
 * in @jaa/core and @jaa/ats.
 *
 * Path selection (server-side only - never a client choice):
 *
 *  - LEVER_API   : the employer-issued Lever API key is configured AND the
 *          application URL exposes a posting id (the documented
 *          `/{site}/{posting}` shape Lever itself uses in applyUrl). In
 *          MOCK mode the base URL must additionally be a LOOPBACK test
 *          fixture - a mock run can never transmit candidate data to the
 *          real API.
 *  - BROWSER_FORM: otherwise. The fallback is NEVER silent: the reason is
 *          reported in the result warnings and recorded in audit events.
 *          Whether the browser path may run at all is decided solely by the
 *          existing core submission policy (capability flag + SSRF policy) -
 *          this module never relaxes it.
 *
 * Answer mapping (never fabricates):
 *  - prepared answers are mapped onto the DOCUMENTED schema from the
 *    "Retrieve posting application questions" endpoint: a label that
 *    matches exactly one documented field always maps to THAT field;
 *    otherwise the inspected semantics map to the documented
 *    personalInformation/urls names (fullName, email, phone, currentCompany,
 *    additionalInformation, LinkedIn, Github, ...);
 *  - choice answers (dropdown / multiple-choice / multiple-select) only
 *    ever send a DOCUMENTED option matched from the approved answer text
 *    against the field's documented `options` list - an unmatched answer is
 *    never guessed;
 *  - custom question values are emitted in the DOCUMENTED field order (the
 *    contract requires the POST to match the retrieved schema);
 *  - EEO answers are sent only when an approved answer grounds them, and
 *    only as documented option texts - never invented;
 *  - the approved resume is sent only as the documented upload-uri
 *    reference (`personalInformation` name `resume`), never as answer text;
 *  - an ambiguous or unmappable answer is a PII-free violation; required
 *    fields without a grounded answer BLOCK the submission before any
 *    request is sent.
 */

import type { AtsFieldFill } from '@jaa/ats';

import {
  isLoopbackBaseUrl,
  validateLeverApplyApplication,
  type LeverApplyCustomQuestionAnswer,
  type LeverApplyField,
  type LeverApplyInput,
  type LeverApplyPersonalValue,
  type LeverApplyQuestionSet,
  type LeverApplyQuestions,
  type LeverApplyViolation,
} from './apply-api';

// ---------------------------------------------------------------------------
// Posting target parsing (documented `/{site}/{posting}` applyUrl shape)
// ---------------------------------------------------------------------------

export interface LeverPostingTarget {
  site: string;
  postingId: string;
}

/**
 * Parse the documented posting URL shape `/{site}/{posting}` (optionally
 * with Lever's own `/apply` suffix), e.g.
 * https://jobs.lever.co/acme/250d8f03-738a-4bba-a671-8a3d73477145/apply.
 * Pure string parsing - no network access, no host allow-listing here (the
 * request itself goes only to the SSRF-guarded API base). URLs that do not
 * expose a posting id (board indexes, custom wrappers) return null: the
 * API path is simply unavailable for them and the browser path remains -
 * never a guessed posting id.
 */
export function parseLeverPostingTarget(url: string): LeverPostingTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length !== 2 && !(segments.length === 3 && segments[2].toLowerCase() === 'apply')) {
    return null;
  }
  const site = decodeURIComponent(segments[0]).trim();
  const postingId = decodeURIComponent(segments[1]).trim();
  if (!site || !postingId) return null;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(postingId)) return null;
  return { site, postingId };
}

// ---------------------------------------------------------------------------
// Server-side credential configuration (never a client-controlled choice)
// ---------------------------------------------------------------------------

/** Employer-issued Lever API key (Basic Auth username, no password). */
export const LEVER_API_KEY_ENV = 'JAA_LEVER_API_KEY';
/**
 * TEST-ONLY base URL override for the local mock Lever API fixture.
 * Enforced by the client's SSRF guard to be loopback (or the documented
 * host). Never set in production.
 */
export const LEVER_API_BASE_ENV = 'JAA_LEVER_API_BASE';

export interface LeverApiConfig {
  /** The employer-issued Lever API key. Never logged, never echoed. */
  apiKey: string;
  /** Test-fixture base URL override; omitted in normal operation. */
  baseUrl?: string;
}

/**
 * Read the Lever API configuration from the server environment. Returns
 * null when no employer key is configured - the API path is then simply
 * unavailable (fail-safe: the existing policy decides what happens next).
 */
export function resolveLeverApiConfig(env: NodeJS.ProcessEnv = process.env): LeverApiConfig | null {
  const apiKey = (env[LEVER_API_KEY_ENV] ?? '').trim();
  if (!apiKey) return null;
  const baseUrl = (env[LEVER_API_BASE_ENV] ?? '').trim();
  return baseUrl ? { apiKey, baseUrl } : { apiKey };
}

// ---------------------------------------------------------------------------
// Submission path selection
// ---------------------------------------------------------------------------

export type LeverSubmissionPath = 'LEVER_API' | 'BROWSER_FORM';

export type LeverSubmissionPathSelection =
  | {
      path: 'LEVER_API';
      target: LeverPostingTarget;
      config: LeverApiConfig;
    }
  | {
      path: 'BROWSER_FORM';
      /** PII-free reason why the API path is unavailable (never silent). */
      reason: string;
    };

/**
 * Choose the submission path from SERVER state only (environment + URL +
 * the policy-decided submission mode). Never consults client input.
 */
export function selectLeverSubmissionPath(params: {
  url: string;
  /** MOCK (loopback target) or REAL - already decided by the core policy. */
  submissionMode?: 'MOCK' | 'REAL';
  env?: NodeJS.ProcessEnv;
}): LeverSubmissionPathSelection {
  const target = parseLeverPostingTarget(params.url);
  if (!target) {
    return {
      path: 'BROWSER_FORM',
      reason:
        'The application URL does not expose the posting id the Apply API needs; using the application form path',
    };
  }
  const config = resolveLeverApiConfig(params.env);
  if (!config) {
    return {
      path: 'BROWSER_FORM',
      reason:
        'No employer-issued Lever API key is configured (JAA_LEVER_API_KEY); using the application form path',
    };
  }
  if (params.submissionMode === 'MOCK') {
    // A mock submission may only ever reach a LOCAL loopback fixture. The
    // real API is never contacted from a mock run, with or without a key.
    if (!config.baseUrl || !isLoopbackBaseUrl(config.baseUrl)) {
      return {
        path: 'BROWSER_FORM',
        reason:
          'Mock submission requires a loopback Lever API fixture base URL (JAA_LEVER_API_BASE); using the mock envelope path',
      };
    }
  }
  return { path: 'LEVER_API', target, config };
}

// ---------------------------------------------------------------------------
// Prepared-answer -> documented-schema mapping (never fabricates)
// ---------------------------------------------------------------------------

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_[_]*$/g, '');
}

function semanticOf(fill: AtsFieldFill): string | null {
  const semantic = fill.locator?.attributes?.['semantic'];
  return typeof semantic === 'string' && semantic.length > 0 ? semantic : null;
}

/** Documented personalInformation names, keyed by the inspected semantics. */
const SEMANTIC_PERSONAL_FIELDS: Record<string, string> = {
  full_name: 'fullName',
  email: 'email',
  phone: 'phone',
};

/** Documented urls names, keyed by the inspected semantics (unique match). */
const SEMANTIC_URL_FIELDS: Record<string, RegExp> = {
  linkedin: /linkedin/i,
  github: /github/i,
  portfolio: /(other|website|portfolio)/i,
};

function valueKindOf(type: string): 'scalar' | 'multi' | 'file' {
  if (type === 'multiple-select') return 'multi';
  if (type === 'file-upload') return 'file';
  return 'scalar';
}

/**
 * Map one approved answer onto a documented option. The approved answer
 * text must match a documented option (by text or by optionId); anything
 * else is never guessed. For `multiple-select` a comma-separated approved
 * answer is accepted ONLY when every non-empty part matches a documented
 * option; otherwise the whole answer is matched as one option text.
 */
function mapChoiceValue(
  field: LeverApplyField,
  text: string
): { ok: true; value: string | string[] } | { ok: false } {
  const options = field.options ?? [];
  const wanted = normalizeLabel(text);
  const find = (candidate: string): LeverApplyField['options'] extends null ? never : {
    text: string;
    optionId?: string | null;
  } | null => {
    const key = normalizeLabel(candidate);
    for (const option of options) {
      if (normalizeLabel(option.text) === key) return option;
      if (option.optionId && option.optionId.trim() === candidate.trim()) return option;
    }
    return null;
  };

  if (valueKindOf(field.type) === 'multi') {
    const parts = text
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length > 1) {
      const matched = parts.map(find);
      if (matched.every((m) => m !== null)) {
        return { ok: true, value: matched.map((m) => (m as { text: string }).text) };
      }
      return { ok: false };
    }
  }

  const single = find(text) ?? (wanted ? null : null);
  if (!single) return { ok: false };
  return {
    ok: true,
    value: valueKindOf(field.type) === 'multi' ? [single.text] : single.text,
  };
}

function emptyValueFor(type: string): string | string[] | null {
  const kind = valueKindOf(type);
  if (kind === 'multi') return [];
  if (kind === 'file') return null;
  return '';
}

/** All documented custom question fields flattened, with their set ids. */
function flattenCustomFields(
  sets: LeverApplyQuestionSet[]
): { setId: string; index: number; field: LeverApplyField }[] {
  const flat: { setId: string; index: number; field: LeverApplyField }[] = [];
  for (const set of sets) {
    set.fields.forEach((field, index) => flat.push({ setId: set.id, index, field }));
  }
  return flat;
}

export interface LeverApplyInputBuild {
  /** The request input (grounded answers + approved resume placeholder). */
  input: LeverApplyInput;
  /** PII-free reasons the submission must be BLOCKED before sending. */
  violations: LeverApplyViolation[];
  /** PII-free notes about unmapped/unmatched answers (never answer text). */
  warnings: string[];
}

/**
 * Build the documented Apply request body from the prepared, human-approved
 * answers. Deterministic and PII-free in all diagnostics: only field names,
 * question texts and problem descriptions are ever reported - never
 * candidate values.
 *
 * `resumeFileName` documents that the approved resume will accompany the
 * application (its upload uri is attached afterwards via
 * {@link withLeverResumeUri}); its content is never part of this body.
 */
export function buildLeverApplyInput(params: {
  questions: LeverApplyQuestions;
  fills: AtsFieldFill[];
  resumeFileName?: string | null;
}): LeverApplyInputBuild {
  const violations: LeverApplyViolation[] = [];
  const warnings: string[] = [];

  const personal = new Map<string, string>();
  const urlValues = new Map<string, string>();
  const customValues = new Map<string, string | string[] | null>(); // `${setId}#${index}`
  const eeoValues: Record<string, string> = {};
  let firstAndLast: { first?: string; last?: string } = {};

  const customFlat = flattenCustomFields(params.questions.customQuestions);

  for (const fill of params.fills) {
    const value = (fill.value ?? '').trim();
    if (!value) continue;

    // The approved resume is sent as the documented upload reference,
    // never as answer text.
    if (fill.fieldType === 'FILE') {
      warnings.push(
        `The file answer for "${fill.label ?? fill.questionId}" is not sent through the API path; only the approved resume upload is`
      );
      continue;
    }

    const label = fill.label ?? null;
    const semantic = semanticOf(fill);

    // 1. A label that matches exactly one documented custom question field
    //    always maps to THAT field (documented id + documented order).
    const customMatches = label
      ? customFlat.filter((entry) => normalizeLabel(entry.field.text) === normalizeLabel(label))
      : [];
    const idMatch = fill.externalFieldId
      ? customFlat.filter((entry) => entry.field.id === fill.externalFieldId)
      : [];
    const matches = idMatch.length > 0 ? idMatch : customMatches;
    if (matches.length > 1) {
      violations.push({
        field: label ?? fill.questionId,
        problem: 'matches more than one documented application question; never guessed',
      });
      continue;
    }
    if (matches.length === 1) {
      const entry = matches[0];
      const kind = valueKindOf(entry.field.type);
      if (kind === 'file') {
        warnings.push(
          `"${entry.field.text}" is a documented file-upload question; only the approved resume upload is ever sent`
        );
        continue;
      }
      if (kind === 'multi' || entry.field.options) {
        const mapped = mapChoiceValue(entry.field, value);
        if (!mapped.ok) {
          const problem =
            'the approved answer matches no documented option and is never guessed';
          if (entry.field.required) {
            violations.push({ field: entry.field.text, problem });
          } else {
            warnings.push(`"${entry.field.text}": ${problem}; the answer was not sent`);
          }
          continue;
        }
        customValues.set(`${entry.setId}#${entry.index}`, mapped.value);
        continue;
      }
      customValues.set(`${entry.setId}#${entry.index}`, value);
      continue;
    }

    // 2. Documented personalInformation fields (label or semantic).
    const personalMatch = label
      ? params.questions.personalInformation.filter(
          (f) =>
            normalizeLabel(f.text) === normalizeLabel(label) ||
            (f.name ? normalizeLabel(f.name) === normalizeLabel(label) : false)
        )
      : [];
    const semanticPersonal = semantic ? SEMANTIC_PERSONAL_FIELDS[semantic] ?? null : null;
    if (personalMatch.length > 1) {
      violations.push({
        field: label ?? fill.questionId,
        problem: 'matches more than one documented application question; never guessed',
      });
      continue;
    }
    if (personalMatch.length === 1) {
      const field = personalMatch[0];
      const name = field.name ?? field.text;
      if (valueKindOf(field.type) === 'file') {
        warnings.push(
          `"${field.text}" is a documented file-upload question; only the approved resume upload is ever sent`
        );
        continue;
      }
      personal.set(name, value);
      continue;
    }
    if (semanticPersonal) {
      if (semanticPersonal === 'fullName' && !value) {
        continue;
      }
      personal.set(semanticPersonal, value);
      continue;
    }

    // 3. Documented urls fields (label or semantic, unique match only).
    const urlMatches = label
      ? params.questions.urls.filter(
          (f) =>
            normalizeLabel(f.text) === normalizeLabel(label) ||
            (f.name ? normalizeLabel(f.name) === normalizeLabel(label) : false)
        )
      : [];
    if (urlMatches.length > 1) {
      violations.push({
        field: label ?? fill.questionId,
        problem: 'matches more than one documented application question; never guessed',
      });
      continue;
    }
    if (urlMatches.length === 1) {
      urlValues.set(urlMatches[0].name ?? urlMatches[0].text, value);
      continue;
    }
    const semanticUrlPattern = semantic ? SEMANTIC_URL_FIELDS[semantic] ?? null : null;
    if (semanticUrlPattern) {
      const candidates = params.questions.urls.filter(
        (f) => semanticUrlPattern.test(f.name ?? f.text)
      );
      if (candidates.length === 1) {
        urlValues.set(candidates[0].name ?? candidates[0].text, value);
        continue;
      }
    }

    // 4. Documented EEO questions (by key or documented text).
    const eeoEntry = Object.entries(params.questions.eeoQuestions).find(
      ([key, field]) =>
        normalizeLabel(key) === normalizeLabel(label ?? '') ||
        normalizeLabel(field.text) === normalizeLabel(label ?? '')
    );
    if (eeoEntry) {
      const [key, field] = eeoEntry;
      if (field.options && field.options.length > 0) {
        const mapped = mapChoiceValue(field, value);
        if (!mapped.ok) {
          const problem = 'the approved answer matches no documented option and is never guessed';
          if (field.required) {
            violations.push({ field: key, problem });
          } else {
            warnings.push(`"${key}": ${problem}; the answer was not sent`);
          }
          continue;
        }
        eeoValues[key] = Array.isArray(mapped.value) ? mapped.value[0] : mapped.value;
        continue;
      }
      eeoValues[key] = value;
      continue;
    }

    // 5. Composed full name: Lever documents ONE fullName field; two
    //    approved name answers compose it (a composition of approved
    //    answers, never an invented fact).
    if (semantic === 'first_name') {
      firstAndLast = { ...firstAndLast, first: value };
      continue;
    }
    if (semantic === 'last_name') {
      firstAndLast = { ...firstAndLast, last: value };
      continue;
    }

    if (!label) {
      warnings.push(
        'A prepared answer without a question label could not be mapped to a documented API field and was not sent'
      );
      continue;
    }
    warnings.push(`No documented application question matches "${label}"; its answer was not sent`);
  }

  if (!personal.has('fullName') && (firstAndLast.first || firstAndLast.last)) {
    personal.set('fullName', [firstAndLast.first, firstAndLast.last].filter(Boolean).join(' '));
  }

  // Assemble the documented request body in the documented field order.
  const personalInformation: LeverApplyPersonalValue[] = [];
  for (const field of params.questions.personalInformation) {
    if (!field.name) continue;
    if (field.name === 'resume') continue; // attached after the upload
    const value = personal.get(field.name);
    if (value != null && value.trim().length > 0) {
      personalInformation.push({ name: field.name, value });
    }
  }
  // Semantically grounded personal values without a documented label match
  // (e.g. email -> `email`) - only when the documented schema knows them.
  for (const [name, value] of personal) {
    if (name === 'resume') continue;
    if (personalInformation.some((p) => p.name === name)) continue;
    const known = params.questions.personalInformation.some((f) => f.name === name);
    if (known && value.trim().length > 0) {
      personalInformation.push({ name, value });
    } else if (!known) {
      warnings.push(
        `The approved answer mapped to "${name}" has no documented field on this application form and was not sent`
      );
    }
  }

  const urls: LeverApplyPersonalValue[] = [];
  for (const field of params.questions.urls) {
    const name = field.name ?? field.text;
    const value = urlValues.get(name);
    if (value != null && value.trim().length > 0) {
      urls.push({ name, value });
    }
  }

  const customQuestions: LeverApplyCustomQuestionAnswer[] = [];
  for (const set of params.questions.customQuestions) {
    const grounded = set.fields.some((_, i) => customValues.has(`${set.id}#${i}`));
    if (!grounded) continue;
    customQuestions.push({
      id: set.id,
      fields: set.fields.map((field, i) => ({
        value: customValues.get(`${set.id}#${i}`) ?? emptyValueFor(field.type),
      })),
    });
  }

  const hasResume = Boolean(params.resumeFileName);
  if (!hasResume) {
    const resumeField = params.questions.personalInformation.find((f) => f.name === 'resume');
    if (resumeField?.required) {
      violations.push({
        field: 'resume',
        problem: 'is required by the application form but no approved resume file is available',
      });
    }
  }

  const input: LeverApplyInput = {
    personalInformation,
    urls,
    customQuestions,
    eeoResponses: Object.keys(eeoValues).length > 0 ? eeoValues : null,
  };
  violations.push(...validateLeverApplyApplication(input, params.questions));
  return { input, violations, warnings };
}

/**
 * Attach the documented resume upload uri to the built input. The value is
 * the `uri` returned by `POST /uploads`, exactly as the documented example
 * shows (`{ "name": "resume", "value": "https://api.lever.co/v1/uploads/..." }`).
 */
export function withLeverResumeUri(
  input: LeverApplyInput,
  uri: string
): LeverApplyInput {
  return {
    ...input,
    personalInformation: [
      ...input.personalInformation.filter((p) => p.name !== 'resume'),
      { name: 'resume', value: uri },
    ],
  };
}
