/**
 * Phase 15C - documented, authorized Lever submission API path (NON-BROWSER).
 *
 * Lever documents an official, employer-authorized way to submit job
 * applications without any browser automation (hire.lever.co/developer
 * /documentation, "Apply to a posting"):
 *
 *   POST https://api.lever.co/v1/postings/:posting/apply
 *   (HTTP Basic Auth: the API key is the username, the password is blank.
 *    The key is created by a Super Admin of the employer's Lever account on
 *    Settings -> Integrations -> API Credentials. OAuth exists only for
 *    registered partner integrations.)
 *
 * Documented companions used by this client:
 *   GET  /v1/postings/:posting/apply   "Retrieve posting application
 *        questions" - the ordered question schema (custom question sets,
 *        personal information, urls, EEO) that the POST body must match;
 *   POST /v1/uploads                   temporary file upload (multipart/
 *        form-data, <= 30MB, valid 24h) whose returned `uri` is referenced
 *        by the application ("if your API key grants access to the Apply to
 *        a posting endpoint, you will have access to this endpoint as well");
 *   Supported file formats (API Overview): docx, doc, js, jpg, png, pdf, txt.
 *
 * Documented success is SPECIFIC and is the only acceptance evidence this
 * client reports: `201 Created` with `{"data":{"applicationId":"<uid>"}}`
 * (the id can be used to view the candidate profile in Lever). A 2xx
 * WITHOUT the documented application id is NOT acceptance evidence - the
 * outcome is UNKNOWN and is never retried blindly.
 *
 * Documented error semantics (API Overview "Responses and Errors"):
 *   400 invalid request, 401 missing/invalid API key, 403 account settings
 *   do not authorize the operation, 404 unknown object, 429 rate limited
 *   (token bucket, 10 req/s steady per API key; the Postings API documents
 *   that a 429'd application POST creates NO application and must be
 *   retried or the applicant is lost), 500/503 provider errors.
 *
 * Security invariants preserved here (same as the Greenhouse client):
 *  - the request goes to exactly one endpoint: the fixed api.lever.co base,
 *    or - for local mock fixtures only - a loopback base URL. Any other
 *    base URL is refused before a connection is opened (SSRF guard);
 *  - exactly ONE submission request per invocation. HTTP redirects are
 *    NEVER followed (redirect: 'manual'): a redirect could re-send the
 *    application body (candidate data, resume) to another host or forge a
 *    false "accepted" 2xx away from the documented endpoint. There is NO
 *    retry of the submission request anywhere: the endpoint has no
 *    idempotency key, so a request that may have landed must never be sent
 *    again (the caller's durable attempt ledger owns single-attempt
 *    enforcement upstream);
 *  - answer values, resume content and the API key are never logged and
 *    never appear in results, warnings, or error messages - diagnostics
 *    name fields and problems only (PII-free).
 */

import { AtsError } from '@jaa/ats';

/** The documented Lever API host. Fixed in normal operation. */
export const LEVER_API_BASE = 'https://api.lever.co';

/** Documented upload formats (API Overview "Supported File Formats"). */
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'txt', 'js', 'jpg', 'png']);

/** Documented hard limit for `POST /uploads` ("limited to 30MB"). */
export const MAX_LEVER_UPLOAD_BYTES = 30 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Documented question schema (GET /v1/postings/:posting/apply, trimmed)
// ---------------------------------------------------------------------------

export interface LeverApplyFieldOption {
  /** The documented option text (used as the answer value by the docs example). */
  text: string;
  /** The documented option id, when the provider exposes one. */
  optionId?: string | null;
}

/**
 * One documented form field. `id` identifies custom-question fields,
 * `name` identifies personalInformation/urls entries - exactly as returned
 * by the question endpoint. Never invented, never re-ordered.
 */
export interface LeverApplyField {
  id?: string | null;
  name?: string | null;
  text: string;
  /** Documented field type: text, textarea, dropdown, multiple-choice,
   *  multiple-select, university, file-upload. */
  type: string;
  required: boolean;
  options?: LeverApplyFieldOption[] | null;
}

/** One documented custom question set (`customQuestions[]` entry). */
export interface LeverApplyQuestionSet {
  id: string;
  text: string;
  /** Documented field order - the POST body must match it exactly. */
  fields: LeverApplyField[];
}

export interface LeverApplyQuestions {
  postingId: string;
  postingText: string | null;
  customQuestions: LeverApplyQuestionSet[];
  personalInformation: LeverApplyField[];
  urls: LeverApplyField[];
  /** Documented EEO question map (gender/race/veteran/disability/...). */
  eeoQuestions: Record<string, LeverApplyField>;
}

// ---------------------------------------------------------------------------
// Base URL policy (SSRF guard)
// ---------------------------------------------------------------------------

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

/** True when a base URL points at a loopback address (local mock fixtures). */
export function isLoopbackBaseUrl(rawUrl: string): boolean {
  try {
    return isLoopbackHostname(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the API base URL. Normal operation uses the fixed documented
 * host. A custom base is accepted ONLY for loopback mock fixtures - any
 * other host (internal services, metadata endpoints, arbitrary remotes) is
 * refused before a connection is ever opened.
 */
export function resolveLeverApiBase(baseUrl?: string): string {
  const raw = (baseUrl ?? LEVER_API_BASE).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AtsError(
      'BLOCKED_BY_SECURITY_POLICY',
      'The Lever API base URL could not be parsed; no request was sent',
      'LEVER'
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AtsError(
      'BLOCKED_BY_SECURITY_POLICY',
      `The Lever API base URL protocol "${parsed.protocol}" is not allowed; no request was sent`,
      'LEVER'
    );
  }
  if (parsed.username || parsed.password) {
    throw new AtsError(
      'BLOCKED_BY_SECURITY_POLICY',
      'The Lever API base URL must not contain credentials; no request was sent',
      'LEVER'
    );
  }
  const isOfficialHost =
    parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'api.lever.co';
  if (!isOfficialHost && !isLoopbackHostname(parsed.hostname)) {
    throw new AtsError(
      'BLOCKED_BY_SECURITY_POLICY',
      `The Lever API base URL host "${parsed.hostname}" is not allowed (only the documented API host or loopback mock fixtures); no request was sent`,
      'LEVER'
    );
  }
  return raw.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Question schema parsing (strict, never invented)
// ---------------------------------------------------------------------------

function parseOption(raw: unknown): LeverApplyFieldOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { text?: unknown; optionId?: unknown };
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return null;
  const optionId =
    typeof record.optionId === 'string' && record.optionId.trim().length > 0
      ? record.optionId.trim()
      : null;
  return optionId ? { text, optionId } : { text };
}

function parseField(raw: unknown, idKey: 'id' | 'name'): LeverApplyField | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : 'text';
  const required = record.required === true;
  const identity =
    typeof record[idKey] === 'string' && record[idKey].trim().length > 0
      ? record[idKey].trim()
      : null;
  const options = Array.isArray(record.options)
    ? record.options.map(parseOption).filter((o): o is LeverApplyFieldOption => o !== null)
    : [];
  return {
    ...(identity ? { [idKey]: identity } : {}),
    text,
    type,
    required,
    options: options.length > 0 ? options : null,
  };
}

/**
 * Parse the documented question response (`{ data: {...} }`) into the
 * trimmed schema this client validates against. Structurally broken pieces
 * are dropped - nothing is ever invented or coerced.
 */
export function parseLeverApplyQuestions(body: string): LeverApplyQuestions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AtsError(
      'INSPECTION_FAILED',
      'The Lever application question list did not contain a JSON body',
      'LEVER'
    );
  }
  const data =
    parsed && typeof parsed === 'object' && 'data' in parsed
      ? (parsed as { data: unknown }).data
      : parsed;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AtsError(
      'INSPECTION_FAILED',
      'The Lever application question list did not contain a question schema',
      'LEVER'
    );
  }
  const record = data as Record<string, unknown>;

  const customQuestions: LeverApplyQuestionSet[] = [];
  if (Array.isArray(record.customQuestions)) {
    for (const rawSet of record.customQuestions) {
      if (!rawSet || typeof rawSet !== 'object') continue;
      const setRecord = rawSet as Record<string, unknown>;
      const id = typeof setRecord.id === 'string' ? setRecord.id.trim() : '';
      if (!id) continue;
      const fields = Array.isArray(setRecord.fields)
        ? setRecord.fields
            .map((f) => parseField(f, 'id'))
            .filter((f): f is LeverApplyField => f !== null)
        : [];
      customQuestions.push({
        id,
        text: typeof setRecord.text === 'string' ? setRecord.text : '',
        fields,
      });
    }
  }

  const personalInformation = Array.isArray(record.personalInformation)
    ? record.personalInformation
        .map((f) => parseField(f, 'name'))
        .filter((f): f is LeverApplyField => f !== null)
    : [];

  const urls = Array.isArray(record.urls)
    ? record.urls.map((f) => parseField(f, 'name')).filter((f): f is LeverApplyField => f !== null)
    : [];

  const eeoQuestions: Record<string, LeverApplyField> = {};
  if (record.eeoQuestions && typeof record.eeoQuestions === 'object') {
    for (const [key, value] of Object.entries(record.eeoQuestions as Record<string, unknown>)) {
      const field = parseField(value, 'name');
      if (field) eeoQuestions[key] = field;
    }
  }

  return {
    postingId: typeof record.id === 'string' ? record.id.trim() : '',
    postingText: typeof record.text === 'string' ? record.text : null,
    customQuestions,
    personalInformation,
    urls,
    eeoQuestions,
  };
}

// ---------------------------------------------------------------------------
// Application input (built by apply-submission.ts; PII-free diagnostics)
// ---------------------------------------------------------------------------

export interface LeverApplyPersonalValue {
  name: string;
  value: string;
}

export interface LeverApplyCustomFieldAnswer {
  /** A documented value: a string, a multi-select option list, or null
   *  (no value) for an unanswered file-upload field. Never invented. */
  value: string | string[] | null;
}

export interface LeverApplyCustomQuestionAnswer {
  /** The documented custom question set id. */
  id: string;
  /** Values in the DOCUMENTED field order, one entry per documented field. */
  fields: LeverApplyCustomFieldAnswer[];
}

export interface LeverApplyInput {
  personalInformation: LeverApplyPersonalValue[];
  urls: LeverApplyPersonalValue[];
  customQuestions: LeverApplyCustomQuestionAnswer[];
  /** Documented EEO responses (key -> documented option text). */
  eeoResponses: Record<string, string> | null;
}

/** A PII-free description of a validation violation. Field names only. */
export interface LeverApplyViolation {
  field: string;
  problem: string;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Validate the documented request rules client-side BEFORE anything is
 * sent: every required documented field must carry a grounded approved
 * answer (never fabricated), custom question answers must match the
 * documented field order, and the email must be well-formed. Returns PII-
 * free violations (field names and problems only - never answer values).
 */
export function validateLeverApplyApplication(
  input: LeverApplyInput,
  questions: LeverApplyQuestions
): LeverApplyViolation[] {
  const violations: LeverApplyViolation[] = [];

  const personalByName = new Map(input.personalInformation.map((p) => [p.name, p.value]));
  for (const field of questions.personalInformation) {
    if (!field.name) continue;
    if (field.name === 'resume') continue; // validated as the upload itself
    const value = (personalByName.get(field.name) ?? '').trim();
    if (field.required && !value) {
      violations.push({ field: field.name, problem: 'is required by the application form' });
    }
    if (field.name === 'email' && value && !looksLikeEmail(value)) {
      violations.push({ field: 'email', problem: 'must be a valid email address' });
    }
  }

  const urlsByName = new Map(input.urls.map((u) => [u.name, u.value]));
  for (const field of questions.urls) {
    if (!field.name) continue;
    const value = (urlsByName.get(field.name) ?? '').trim();
    if (field.required && !value) {
      violations.push({ field: field.name, problem: 'is required by the application form' });
    }
  }

  const answersById = new Map(input.customQuestions.map((c) => [c.id, c]));
  for (const set of questions.customQuestions) {
    const answer = answersById.get(set.id);
    for (let i = 0; i < set.fields.length; i += 1) {
      const field = set.fields[i];
      const value = answer?.fields[i]?.value;
      const empty =
        value == null ||
        (typeof value === 'string' && value.trim().length === 0) ||
        (Array.isArray(value) && value.length === 0);
      if (field.required && empty) {
        violations.push({
          field: field.text || `${set.text}#${i + 1}`,
          problem: 'is required by the application form but has no approved answer',
        });
      }
    }
    if (answer && answer.fields.length !== set.fields.length) {
      violations.push({
        field: set.text || set.id,
        problem: `must carry exactly ${set.fields.length} field value(s) in the documented order`,
      });
    }
  }

  for (const [key, field] of Object.entries(questions.eeoQuestions)) {
    const value = (input.eeoResponses?.[key] ?? '').trim();
    if (field.required && !value) {
      violations.push({ field: key, problem: 'is required by the application form' });
    }
  }

  return violations;
}

/**
 * Validate the approved resume file against the documented upload rules
 * (documented formats, non-empty, <= 30MB) BEFORE anything is sent.
 */
export function validateLeverUploadFile(file: {
  filename: string;
  content: Uint8Array;
}): LeverApplyViolation[] {
  const violations: LeverApplyViolation[] = [];
  const extension = file.filename.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
    violations.push({
      field: 'resume',
      problem: `file type ".${extension || '(none)'}" is not a documented upload format (pdf, doc, docx, txt, js, jpg, png)`,
    });
  }
  if (!file.content || file.content.length === 0) {
    violations.push({ field: 'resume', problem: 'the file is empty (documented: max 30MB, a real file)' });
  } else if (file.content.length > MAX_LEVER_UPLOAD_BYTES) {
    violations.push({
      field: 'resume',
      problem: `the file exceeds the documented 30MB upload limit (${file.content.length} bytes)`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Pre-transmission failure detection (the request never left this machine)
// ---------------------------------------------------------------------------

const PRE_TRANSMISSION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * True only when the network error proves the request was never
 * transmitted (no connection was ever established). Everything else
 * (resets, timeouts mid-request, socket deaths) is treated as an UNKNOWN
 * outcome - when in doubt the outcome is always unknown, never retried.
 */
export function isDefinitelyNotTransmitted(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && PRE_TRANSMISSION_ERROR_CODES.has(code)) return true;
    const nested = (current as { errors?: unknown }).errors;
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        const nestedCode =
          entry && typeof entry === 'object' ? (entry as { code?: unknown }).code : undefined;
        if (typeof nestedCode === 'string' && PRE_TRANSMISSION_ERROR_CODES.has(nestedCode)) {
          return true;
        }
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Read-only question fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the documented application question list (GET
 * /v1/postings/:posting/apply - "Retrieve posting application questions").
 * Authenticated read-only request used to ground the answer mapping and the
 * client-side required validation. Redirects are never followed.
 */
export async function fetchLeverApplyQuestions(options: {
  apiKey: string;
  postingId: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<LeverApplyQuestions> {
  const base = resolveLeverApiBase(options.baseUrl);
  const target = `${base}/v1/postings/${encodeURIComponent(options.postingId)}/apply`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(target, {
      headers: {
        // Basic Auth: username is the API key, no password (documented).
        authorization: `Basic ${Buffer.from(`${options.apiKey}:`).toString('base64')}`,
      },
      signal: controller.signal,
      // Redirects are never followed - a redirect could point the read at
      // an internal host (SSRF) or non-documented content.
      redirect: 'manual',
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AtsError(
          'INSPECTION_FAILED',
          `The Lever API refused the configured employer credentials (HTTP ${response.status}) for the question list; verify the employer-issued API key and its permissions`,
          'LEVER'
        );
      }
      throw new AtsError(
        'INSPECTION_FAILED',
        response.status >= 300 && response.status < 400
          ? `The Lever question list answered a redirect (HTTP ${response.status}) which is never followed`
          : `The Lever question list could not be read (HTTP ${response.status})`,
        'LEVER'
      );
    }
    return parseLeverApplyQuestions(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Documented temporary file upload (POST /v1/uploads)
// ---------------------------------------------------------------------------

export interface LeverUploadResult {
  /** The documented `uri` to reference from the application. */
  uri: string;
  /** Documented expiry (ms epoch), when the provider returned one. */
  expiresAt: number | null;
}

/**
 * Upload the approved resume through the documented `POST /v1/uploads`
 * endpoint (multipart/form-data). The returned `uri` is referenced by the
 * application's `resume` personal-information value.
 *
 * The upload stores a TEMPORARY file only ("available to use in requests
 * for 24 hours") - it can never create an application by itself. Failures
 * here are therefore known pre-application failures: a 4xx is a definitive
 * refusal of the request, and a network/5xx failure is transient (nothing
 * application-like exists either way, so a later attempt is safe).
 */
export async function uploadLeverApplyFile(options: {
  apiKey: string;
  filename: string;
  content: Uint8Array;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<LeverUploadResult> {
  const violations = validateLeverUploadFile(options);
  if (violations.length > 0) {
    throw new AtsError(
      'SUBMISSION_FAILED',
      `The approved resume was not uploaded (nothing was submitted): ${violations
        .map((v) => `${v.field} ${v.problem}`)
        .join('; ')}`,
      'LEVER'
    );
  }

  const base = resolveLeverApiBase(options.baseUrl);
  const target = `${base}/v1/uploads`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const form = new FormData();
    form.append(
      'file',
      // Fresh ArrayBuffer-backed copy (Blob requires ArrayBuffer-backed
      // views; the caller's bytes are used unchanged otherwise).
      new Blob([new Uint8Array(options.content)]),
      options.filename
    );
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${options.apiKey}:`).toString('base64')}`,
        },
        body: form,
        signal: controller.signal,
        // Redirects are never followed - the file must not be re-sent to
        // another host and a 2xx away from the documented endpoint is not
        // evidence of anything.
        redirect: 'manual',
      });
    } catch (err) {
      if (isDefinitelyNotTransmitted(err)) {
        throw new AtsError(
          'PROVIDER_UNAVAILABLE',
          `The Lever upload request was never transmitted (nothing was submitted): ${
            err instanceof Error ? err.message : String(err)
          }`,
          'LEVER',
          err
        );
      }
      throw new AtsError(
        'PROVIDER_UNAVAILABLE',
        `The Lever upload request failed in transit (no application exists; a later attempt is safe): ${
          err instanceof Error ? err.message : String(err)
        }`,
        'LEVER',
        err
      );
    }

    if (response.status >= 200 && response.status < 300) {
      let uri: string | null = null;
      let expiresAt: number | null = null;
      try {
        const parsed = (await response.json()) as {
          data?: { uri?: unknown; expiresAt?: unknown };
        };
        const data = parsed?.data;
        if (data && typeof data.uri === 'string' && data.uri.trim().length > 0) {
          uri = data.uri.trim();
          if (typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt)) {
            expiresAt = data.expiresAt;
          }
        }
      } catch {
        // fall through
      }
      if (!uri) {
        throw new AtsError(
          'PROVIDER_UNAVAILABLE',
          'The Lever upload answered without the documented file uri; no application exists and a later attempt is safe',
          'LEVER'
        );
      }
      return { uri, expiresAt };
    }

    if (response.status === 401 || response.status === 403) {
      throw new AtsError(
        'SUBMISSION_FAILED',
        `The Lever API refused the configured employer credentials (HTTP ${response.status}) for the file upload; nothing was submitted - verify the employer-issued API key and its permissions`,
        'LEVER'
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new AtsError(
        'PROVIDER_UNAVAILABLE',
        `The Lever upload answered a redirect (HTTP ${response.status}) which is never followed; no application exists and a later attempt is safe`,
        'LEVER'
      );
    }
    if (response.status >= 400 && response.status < 500) {
      throw new AtsError(
        'SUBMISSION_FAILED',
        `The Lever upload was refused (HTTP ${response.status}); nothing was submitted`,
        'LEVER'
      );
    }
    throw new AtsError(
      'PROVIDER_UNAVAILABLE',
      `The Lever upload failed (HTTP ${response.status}); no application exists and a later attempt is safe`,
      'LEVER'
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Submission (POST /v1/postings/:posting/apply)
// ---------------------------------------------------------------------------

/**
 * Extract the provider reference from the DOCUMENTED success body,
 * strictly: only a non-empty `data.applicationId` string the provider
 * actually returned. Empty, malformed, or structured values never produce
 * a reference - nothing is ever invented, coerced, or picked from other
 * fields.
 */
export function extractLeverApplyReference(responseBody: string): string | null {
  if (!responseBody || !responseBody.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const data = (parsed as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const applicationId = (data as { applicationId?: unknown }).applicationId;
  if (typeof applicationId !== 'string') return null;
  const trimmed = applicationId.trim();
  return trimmed.length > 0 && trimmed.length <= 255 ? trimmed : null;
}

export interface LeverApplySubmissionOptions {
  /** The employer-issued Lever API key (Basic Auth username, no password). */
  apiKey: string;
  postingId: string;
  input: LeverApplyInput;
  /** Test fixtures only: a loopback base URL. Omit in normal operation. */
  baseUrl?: string;
  /** Request timeout in ms (default 30s). After it fires the outcome is unknown. */
  timeoutMs?: number;
  /**
   * Documented query parameter `send_confirmation_email` (defaults to
   * false in the documented contract - Lever does not email the candidate
   * unless it is explicitly requested).
   */
  sendConfirmationEmail?: boolean;
}

/**
 * Outcome of ONE documented Apply-to-a-posting attempt.
 *
 *  - ACCEPTED: the provider answered the documented success contract
 *    (2xx WITH the documented `data.applicationId`). The reference is the
 *    provider's own application id - authoritative acceptance evidence.
 *  - REFUSED: the provider answered 4xx and refused - definitive, NOTHING
 *    was created. (A documented 429 is a rate-limit refusal that creates
 *    no application.)
 *  - BLOCKED: client-side validation refused the attempt BEFORE any
 *    request was sent - definitive, nothing was sent.
 *
 * A THROWN AtsError always means the outcome is UNKNOWN
 * (`SUBMISSION_UNCONFIRMED`): the request may have reached the provider and
 * must never be retried blindly. This includes a 2xx WITHOUT the documented
 * application id - the documented contract is "201 + data.applicationId",
 * so anything else is not acceptance evidence.
 */
export type LeverApplySubmissionResult =
  | { kind: 'ACCEPTED'; httpStatus: number; reference: string }
  | { kind: 'REFUSED'; httpStatus: number; detail: string }
  | { kind: 'BLOCKED'; violations: LeverApplyViolation[] };

/**
 * Submit ONE application through the documented endpoint. Exactly one HTTP
 * request is issued - there is no retry on any path (the endpoint has no
 * idempotency support, so a request that may have landed must never be
 * repeated from here; the caller's durable attempt ledger owns single-
 * attempt enforcement and an unknown outcome blocks any new attempt).
 */
export async function submitLeverApplyApplication(
  options: LeverApplySubmissionOptions
): Promise<LeverApplySubmissionResult> {
  const base = resolveLeverApiBase(options.baseUrl);
  const query =
    options.sendConfirmationEmail === true ? '?send_confirmation_email=true' : '';
  const target = `${base}/v1/postings/${encodeURIComponent(options.postingId)}/apply${query}`;

  if (!options.apiKey || options.apiKey.trim().length === 0) {
    return {
      kind: 'BLOCKED',
      violations: [
        {
          field: 'lever_api_key',
          problem: 'no Lever API key is configured (the employer-issued key is required)',
        },
      ],
    };
  }

  const body: Record<string, unknown> = {
    customQuestions: options.input.customQuestions,
    personalInformation: options.input.personalInformation,
    urls: options.input.urls,
  };
  if (options.input.eeoResponses && Object.keys(options.input.eeoResponses).length > 0) {
    body.eeoResponses = options.input.eeoResponses;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  let status = 0;
  let responseBody = '';
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${options.apiKey}:`).toString('base64')}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Redirects are NEVER followed: the application body must not be
      // re-sent to another location, and a 2xx from anywhere other than the
      // documented endpoint is not evidence for this submission.
      redirect: 'manual',
    });
    status = response.status;
    responseBody = await response.text().catch(() => '');
  } catch (err) {
    if (isDefinitelyNotTransmitted(err)) {
      throw new AtsError(
        'SUBMISSION_FAILED',
        `The Lever application request was never transmitted (${
          err instanceof Error ? err.message : String(err)
        }); nothing was submitted`,
        'LEVER',
        err
      );
    }
    throw new AtsError(
      'SUBMISSION_UNCONFIRMED',
      `The Lever application submission request outcome is unknown (the request may have reached the provider and must never be retried blindly): ${
        err instanceof Error ? err.message : String(err)
      }`,
      'LEVER',
      err
    );
  } finally {
    clearTimeout(timeout);
  }

  if (status >= 200 && status < 300) {
    // The DOCUMENTED success contract is a created application WITH its id.
    // A 2xx without it is not acceptance evidence - the outcome cannot be
    // proven and must never be retried blindly.
    const reference = extractLeverApplyReference(responseBody);
    if (!reference) {
      throw new AtsError(
        'SUBMISSION_UNCONFIRMED',
        `The Lever API answered HTTP ${status} without the documented application id; the submission outcome cannot be proven and must never be retried blindly`,
        'LEVER'
      );
    }
    return { kind: 'ACCEPTED', httpStatus: status, reference };
  }

  if (status >= 300 && status < 400) {
    // The provider answered with a redirect instead of accepting the
    // application at the documented endpoint. It was never followed, so
    // nothing was re-sent elsewhere - but whether the provider recorded
    // the application cannot be proven: UNKNOWN, never retried.
    throw new AtsError(
      'SUBMISSION_UNCONFIRMED',
      `The Lever API answered HTTP ${status} (a redirect, which is never followed); the submission outcome cannot be proven and must never be retried blindly`,
      'LEVER'
    );
  }

  if (status === 429) {
    // Documented rate-limit refusal: the request was throttled and no
    // application is created ("retry all requests that receive a 429 or
    // you will lose applicants" - the Postings API). Definitive: nothing
    // was submitted.
    return {
      kind: 'REFUSED',
      httpStatus: status,
      detail: `the Lever API rate-limited the request (HTTP 429) and created no application (documented: a 429'd application POST never creates an application)`,
    };
  }

  if (status >= 400 && status < 500) {
    // The provider answered and refused (auth/validation): definitive -
    // nothing was created. The detail is PII-free (status only, never
    // answer values).
    return {
      kind: 'REFUSED',
      httpStatus: status,
      detail: `the Lever API refused the application (HTTP ${status})`,
    };
  }

  // 5xx and anything else: the provider received the request but its
  // outcome cannot be proven either way. UNKNOWN - never retried blindly.
  throw new AtsError(
    'SUBMISSION_UNCONFIRMED',
    `The Lever API answered HTTP ${status} without a verifiable outcome; the application may or may not have been created and must never be retried blindly`,
    'LEVER'
  );
}
