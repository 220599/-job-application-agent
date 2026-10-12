/**
 * Phase 15B.2 - Greenhouse Job Board API orchestration glue.
 *
 * Connects the documented, employer-authorized Job Board API client
 * (job-board-api.ts) to the generic @jaa/ats submission boundary. Vendor
 * specifics live HERE (and in the adapter); generic submission policy stays
 * in @jaa/core and @jaa/ats.
 *
 * Path selection (server-side only - never a client choice):
 *
 *  - JOB_BOARD_API : the employer-issued Job Board API key is configured
 *          AND the application URL exposes a board token + job post id
 *          (the documented `/{board_token}/jobs/{id}` shape). In MOCK mode
 *          the base URL must additionally be a LOOPBACK test fixture - a
 *          mock run can never transmit candidate data to the real API.
 *  - BROWSER_FORM  : otherwise. The fallback is NEVER silent: the reason is
 *          reported in the result warnings and recorded in audit events.
 *          Whether the browser path may run at all is decided solely by the
 *          existing core submission policy (capability flag + SSRF policy) -
 *          this module never relaxes it.
 *
 * Answer mapping (never fabricates):
 *  - prepared answers are mapped onto the DOCUMENTED field names from the
 *    Job method with `?questions=true`: a label that matches exactly one
 *    documented question always maps to THAT question's field (a "Preferred
 *    First Name" answer never overwrites `first_name`); only when no
 *    documented question carries the label are the built-in names
 *    (`first_name`, `last_name`, `email`, `phone`, `location`) filled from
 *    the inspected field semantics;
 *  - multi-value fields only ever send a documented option `value` matched
 *    from the approved answer text against the field's documented `values`
 *    list - an unmatched answer is never guessed;
 *  - an ambiguous or unmappable answer is a PII-free violation; required
 *    questions without a grounded answer BLOCK the submission before any
 *    request is sent (the docs mandate client-side required validation:
 *    "Greenhouse will not reject applications that are missing required
 *    fields").
 */

import type { AtsFieldFill, AtsFieldOption } from '@jaa/ats';

import {
  findUnansweredRequiredQuestions,
  isLoopbackBaseUrl,
  type GreenhouseJobBoardAnswer,
  type GreenhouseJobBoardApplicationInput,
  type GreenhouseJobBoardAttachment,
  type GreenhouseJobBoardQuestion,
  type GreenhouseJobBoardQuestionField,
  type GreenhouseJobBoardViolation,
} from './job-board-api';

// ---------------------------------------------------------------------------
// Job Board API target parsing (documented `/{board_token}/jobs/{id}` shape)
// ---------------------------------------------------------------------------

export interface GreenhouseJobBoardTarget {
  boardToken: string;
  jobPostId: string;
}

/**
 * Parse the documented job-board URL shape `/{board_token}/jobs/{id}` (e.g.
 * https://job-boards.greenhouse.io/{board_token}/jobs/127817). Pure string
 * parsing - no network access, no host allow-listing here (the request
 * itself goes only to the SSRF-guarded API base). URLs that do not expose
 * both parts (custom-domain wrappers, embed frames, board indexes) return
 * null: the Job Board API path is simply unavailable for them and the
 * browser path remains - never a guessed board token.
 */
export function parseGreenhouseJobBoardTarget(url: string): GreenhouseJobBoardTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  const match = /^\/([^/]+)\/jobs\/(\d+)(?:\/|$)/.exec(parsed.pathname);
  if (!match) return null;
  const boardToken = decodeURIComponent(match[1]).trim();
  const jobPostId = match[2].trim();
  if (!boardToken || !jobPostId) return null;
  return { boardToken, jobPostId };
}

// ---------------------------------------------------------------------------
// Server-side credential configuration (never a client-controlled choice)
// ---------------------------------------------------------------------------

/** Employer-issued Job Board API key (Basic Auth username, no password). */
export const GREENHOUSE_JOB_BOARD_API_KEY_ENV = 'JAA_GREENHOUSE_JOB_BOARD_API_KEY';
/**
 * TEST-ONLY base URL override for the local mock Job Board API fixture.
 * Enforced by the client's SSRF guard to be loopback (or the documented
 * host). Never set in production.
 */
export const GREENHOUSE_JOB_BOARD_API_BASE_ENV = 'JAA_GREENHOUSE_JOB_BOARD_API_BASE';

export interface GreenhouseJobBoardApiConfig {
  /** The employer-issued Job Board API key. Never logged, never echoed. */
  apiKey: string;
  /** Test-fixture base URL override; omitted in normal operation. */
  baseUrl?: string;
}

/**
 * Read the Job Board API configuration from the server environment. Returns
 * null when no employer key is configured - the API path is then simply
 * unavailable (fail-safe: the existing policy decides what happens next).
 */
export function resolveGreenhouseJobBoardApiConfig(
  env: NodeJS.ProcessEnv = process.env
): GreenhouseJobBoardApiConfig | null {
  const apiKey = (env[GREENHOUSE_JOB_BOARD_API_KEY_ENV] ?? '').trim();
  if (!apiKey) return null;
  const baseUrl = (env[GREENHOUSE_JOB_BOARD_API_BASE_ENV] ?? '').trim();
  return baseUrl ? { apiKey, baseUrl } : { apiKey };
}

// ---------------------------------------------------------------------------
// Submission path selection
// ---------------------------------------------------------------------------

export type GreenhouseSubmissionPath = 'JOB_BOARD_API' | 'BROWSER_FORM';

export type GreenhouseSubmissionPathSelection =
  | {
      path: 'JOB_BOARD_API';
      target: GreenhouseJobBoardTarget;
      config: GreenhouseJobBoardApiConfig;
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
export function selectGreenhouseSubmissionPath(params: {
  url: string;
  /** MOCK (loopback target) or REAL - already decided by the core policy. */
  submissionMode?: 'MOCK' | 'REAL';
  env?: NodeJS.ProcessEnv;
}): GreenhouseSubmissionPathSelection {
  const target = parseGreenhouseJobBoardTarget(params.url);
  if (!target) {
    return {
      path: 'BROWSER_FORM',
      reason:
        'The application URL does not expose the board token and job post id the Job Board API needs; using the application form path',
    };
  }
  const config = resolveGreenhouseJobBoardApiConfig(params.env);
  if (!config) {
    return {
      path: 'BROWSER_FORM',
      reason:
        'No employer-issued Job Board API key is configured (JAA_GREENHOUSE_JOB_BOARD_API_KEY); using the application form path',
    };
  }
  if (params.submissionMode === 'MOCK') {
    // A mock submission may only ever reach a LOCAL loopback fixture. The
    // real API is never contacted from a mock run, with or without a key.
    if (!config.baseUrl || !isLoopbackBaseUrl(config.baseUrl)) {
      return {
        path: 'BROWSER_FORM',
        reason:
          'Mock submission requires a loopback Job Board API fixture base URL (JAA_GREENHOUSE_JOB_BOARD_API_BASE); using the mock envelope path',
      };
    }
  }
  return { path: 'JOB_BOARD_API', target, config };
}

// ---------------------------------------------------------------------------
// Prepared-answer -> documented-field mapping (never fabricates)
// ---------------------------------------------------------------------------

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Built-in documented request fields, keyed by the inspected semantics. */
const SEMANTIC_BUILTIN_FIELDS: Record<string, string> = {
  first_name: 'first_name',
  last_name: 'last_name',
  email: 'email',
  phone: 'phone',
  location: 'location',
};

function semanticOf(fill: AtsFieldFill): string | null {
  const semantic = fill.locator?.attributes?.['semantic'];
  return typeof semantic === 'string' && semantic.length > 0 ? semantic : null;
}

/**
 * Pick the documented field within a question for this fill: a FILE answer
 * uses the `input_file` field, text uses `textarea`/`input_text`, and
 * multi-choice answers use the `multi_value_*` field.
 */
function pickFieldForFill(
  question: GreenhouseJobBoardQuestion,
  fill: AtsFieldFill
): GreenhouseJobBoardQuestionField | null {
  const fields = question.fields ?? [];
  if (fields.length === 0) return null;
  if (fields.length === 1) return fields[0];
  const wantsFile = fill.fieldType === 'FILE';
  const wantsChoice =
    fill.fieldType === 'SELECT' || fill.fieldType === 'RADIO' || fill.fieldType === 'CHECKBOX';
  const byType = fields.find((field) => {
    if (wantsFile) return field.type === 'input_file';
    if (wantsChoice) return field.type.startsWith('multi_value');
    return field.type === 'textarea' || field.type === 'input_text';
  });
  return byType ?? fields[0];
}

/**
 * Map one approved answer onto a documented option value. The approved
 * answer text must match a documented option (by label or by value);
 * anything else is never guessed.
 */
function mapChoiceValue(
  field: GreenhouseJobBoardQuestionField,
  text: string
): { ok: true; value: string | number } | { ok: false } {
  const values = field.values ?? [];
  const wanted = normalizeLabel(text);
  for (const option of values) {
    if (normalizeLabel(option.label) === wanted || String(option.value).trim() === text.trim()) {
      return { ok: true, value: option.value };
    }
  }
  return { ok: false };
}

function questionByLabel(
  questions: GreenhouseJobBoardQuestion[],
  label: string
): { question: GreenhouseJobBoardQuestion } | { ambiguous: true } | null {
  const wanted = normalizeLabel(label);
  const matches = (questions ?? []).filter((question) => normalizeLabel(question.label) === wanted);
  if (matches.length === 0) return null;
  if (matches.length > 1) return { ambiguous: true };
  return { question: matches[0] };
}

export interface GreenhouseJobBoardInputBuild {
  /** The request input (answers + approved resume attachment). */
  input: GreenhouseJobBoardApplicationInput;
  /** PII-free reasons the submission must be BLOCKED before sending. */
  violations: GreenhouseJobBoardViolation[];
  /** PII-free notes about unmapped/unmatched answers (never answer text). */
  warnings: string[];
}

/**
 * Build the documented Job Board API request input from the prepared,
 * human-approved answers. Deterministic and PII-free in all diagnostics:
 * only field names, question labels and problem descriptions are ever
 * reported - never candidate values.
 *
 * `resumeFileName` is the display name for the approved resume attachment
 * (`resumeContentBase64` is the already-encoded approved file content).
 */
export function buildGreenhouseJobBoardInput(params: {
  questions: GreenhouseJobBoardQuestion[];
  fills: AtsFieldFill[];
  resumeContentBase64?: string | null;
  resumeFileName?: string | null;
}): GreenhouseJobBoardInputBuild {
  const violations: GreenhouseJobBoardViolation[] = [];
  const warnings: string[] = [];
  const answers: GreenhouseJobBoardAnswer[] = [];
  /** Field names grounded in an approved answer (for the coverage check). */
  const checkAnswers: GreenhouseJobBoardAnswer[] = [];

  for (const fill of params.fills) {
    const value = (fill.value ?? '').trim();
    if (!value) continue;

    // The approved resume is sent as an attachment, never as answer text.
    if (fill.fieldType === 'FILE') {
      warnings.push(
        `The file answer for "${fill.label ?? fill.questionId}" is not sent through the API path; only the approved resume attachment is`
      );
      continue;
    }

    // Label-vs-semantic precedence (never overwrite a documented built-in):
    // a fill whose label matches exactly one documented question is always
    // mapped to THAT question's field. The inspected semantic built-in
    // mapping is used only when no documented question carries the label, or
    // when the matched question IS the built-in question itself (e.g. the
    // `first_name` field inside the documented "Name" question).
    const semantic = semanticOf(fill);
    const semanticBuiltin = semantic ? SEMANTIC_BUILTIN_FIELDS[semantic] ?? null : null;
    const label = fill.label ?? null;

    const match = label ? questionByLabel(params.questions, label) : null;
    if (match && 'ambiguous' in match) {
      violations.push({
        // `match` implies `label` is present; the fallback only satisfies the type checker.
        field: label ?? fill.questionId,
        problem: 'matches more than one documented API question; never guessed',
      });
      continue;
    }

    if (match) {
      const builtinField = semanticBuiltin
        ? (match.question.fields ?? []).find((f) => f.name === semanticBuiltin)
        : undefined;
      const field = builtinField ?? pickFieldForFill(match.question, fill);
      if (!field) {
        warnings.push(`The documented API question "${label}" has no field to receive an answer`);
        continue;
      }

      const isChoice = field.type.startsWith('multi_value');
      if (isChoice) {
        const mapped = mapChoiceValue(field, value);
        if (!mapped.ok) {
          const problem =
            'the approved answer matches no documented option value and is never guessed';
          if (match.question.required) {
            violations.push({ field: field.name, problem });
          } else {
            warnings.push(`"${label}": ${problem}; the answer was not sent`);
          }
          continue;
        }
        answers.push({ name: field.name, value: mapped.value });
        checkAnswers.push({ name: field.name, value: mapped.value });
        continue;
      }

      answers.push({ name: field.name, value });
      checkAnswers.push({ name: field.name, value });
      continue;
    }

    if (semanticBuiltin) {
      answers.push({ name: semanticBuiltin, value });
      checkAnswers.push({ name: semanticBuiltin, value });
      continue;
    }

    if (!label) {
      warnings.push(
        'A prepared answer without a question label could not be mapped to a documented API field and was not sent'
      );
      continue;
    }
    warnings.push(
      `No documented API question matches "${label}"; its answer was not sent`
    );
  }

  let resume: GreenhouseJobBoardAttachment | null = null;
  if (params.resumeContentBase64 && params.resumeFileName) {
    resume = {
      contentBase64: params.resumeContentBase64,
      filename: params.resumeFileName,
    };
    // The documented `resume` field is satisfied by the attachment.
    checkAnswers.push({ name: 'resume', value: params.resumeFileName });
  }

  // Documented client-side required validation ("Greenhouse will not
  // reject applications that are missing required fields").
  for (const missing of findUnansweredRequiredQuestions(params.questions, checkAnswers)) {
    violations.push({
      field: missing,
      problem: 'is required by the job post but has no approved answer (never fabricated)',
    });
  }

  return {
    input: {
      answers,
      resume,
      coverLetter: null,
      mappedUrlToken: null,
    },
    violations,
    warnings,
  };
}
