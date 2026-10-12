/**
 * Phase 15B.1 - documented, authorized Greenhouse Job Board API submission
 * path (NON-BROWSER).
 *
 * Greenhouse documents an official, employer-authorized way to submit job
 * applications without any browser automation:
 *
 *   POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}
 *   (HTTP Basic Auth: the username is the board's Job Board API key, which
 *   the employer finds on their Greenhouse "API Credentials" page; no
 *   password. Docs: https://docs.greenhouse.io/job-board.html)
 *
 * This path carries NO browser-based CAPTCHA/reCAPTCHA challenge at all
 * (Greenhouse's own spam protection lives on the embedded web form), so it
 * is the supported submission method whenever the employer has authorized
 * us with a Job Board API key. Without that key the browser path (the
 * adapter in adapter.ts) remains the only candidate-side option, and its
 * CAPTCHA policy is unchanged: detected, never solved, never bypassed.
 *
 * Documented behaviors this client encodes:
 *  - "Greenhouse will not confirm the inclusion of required fields.
 *     Validation for required fields must be done on the client side" -
 *     so this client validates BEFORE sending and refuses to send an
 *     application that is missing documented required fields (a silent
 *     partial application would be worse than a refusal);
 *  - the documented request validations (first_name/last_name/email
 *     required and <= 255 chars, no URLs in name/phone fields, valid email,
 *     attachments must be pdf/doc/docx/txt/rtf);
 *  - attachments go as base64 `*_content` + `*_filename` (the documented
 *     JSON upload method), the approved resume only;
 *  - the response body is NOT documented - a 2xx is provider acceptance
 *     but no confirmation id can be promised, so `reference` is null unless
 *     the provider actually returns one.
 *
 * Security invariants preserved here:
 *  - the request goes to exactly one endpoint: the fixed
 *    boards-api.greenhouse.io base, or - for local mock fixtures only - a
 *    loopback base URL. Any other base URL is refused (SSRF guard);
 *  - exactly ONE POST per invocation, to the validated URL only. HTTP
 *    redirects are NEVER followed (redirect: 'manual'): a redirect could
 *    bounce the application body (candidate data, resume) to another host
 *    or turn a non-evidence 3xx into a false "accepted" 2xx. There is NO
 *    retry anywhere: the Board API has no idempotency key, so a request
 *    that may have landed must never be sent again (the caller's durable
 *    attempt ledger owns single-attempt enforcement upstream);
 *  - answer values are sent to the provider endpoint only. They are never
 *    logged and never appear in results, warnings, or error messages -
 *    diagnostics name fields and types only (PII-free);
 *  - the API key is used for exactly one Authorization header and is never
 *    logged, echoed, or placed in any result.
 */

import { AtsError } from '@jaa/ats';

/** The documented Job Board API host. Fixed in normal operation. */
export const GREENHOUSE_JOB_BOARD_API_BASE = 'https://boards-api.greenhouse.io';

/** Documented attachment types (Job Board API "Attachments" rules). */
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'txt', 'rtf']);

/** Documented hard limits for the identity fields. */
const MAX_IDENTITY_FIELD_LENGTH = 255;

/** A single prepared answer, keyed by the DOCUMENTED form field name. */
export interface GreenhouseJobBoardAnswer {
  /**
   * The documented request field name: `first_name`, `last_name`, `email`,
   * `phone`, `location`, or a custom question name such as `question_12345`
   * (exactly the `fields[].name` values returned by the Job method with
   * `?questions=true`).
   */
  name: string;
  /**
   * Answer text, a documented option value (numeric for multi-value
   * fields), or a list for multi-select questions. Never logged.
   */
  value: string | number | Array<string | number>;
}

/** A file attachment for the application (approved content only). */
export interface GreenhouseJobBoardAttachment {
  /** Base64 file content (the documented JSON upload method). */
  contentBase64: string;
  /** File name including extension - the extension must be document-supported. */
  filename: string;
}

export interface GreenhouseJobBoardApplicationInput {
  answers: GreenhouseJobBoardAnswer[];
  resume?: GreenhouseJobBoardAttachment | null;
  coverLetter?: GreenhouseJobBoardAttachment | null;
  /** Optional documented referral token (the `gh_src` URL parameter). */
  mappedUrlToken?: string | null;
}

/** A documented option of a multi-value field (`values` in the Job method). */
export interface GreenhouseJobBoardQuestionFieldValue {
  /** The documented option value to send (numeric in the docs examples). */
  value: string | number;
  /** The option's display label. */
  label: string;
}

/**
 * One question definition as returned by the documented Job method with
 * `?questions=true` (a trimmed view of the fields this client validates).
 */
export interface GreenhouseJobBoardQuestionField {
  name: string;
  type: string;
  /** Documented option values for `multi_value_*` field types. */
  values?: GreenhouseJobBoardQuestionFieldValue[] | null;
}

export interface GreenhouseJobBoardQuestion {
  required: boolean;
  label: string;
  fields: GreenhouseJobBoardQuestionField[];
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
export function resolveJobBoardApiBase(baseUrl?: string): string {
  const raw = (baseUrl ?? GREENHOUSE_JOB_BOARD_API_BASE).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AtsError(
      'BLOCKED_BY_SECURITY_POLICY',
      'The Greenhouse Job Board API base URL could not be parsed; no request was sent',
      'GREENHOUSE'
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AtsError(
      'BLOCKED_BY_SECURITY_POLICY',
      `The Greenhouse Job Board API base URL protocol "${parsed.protocol}" is not allowed; no request was sent`,
      'GREENHOUSE'
    );
  }
  if (parsed.username || parsed.password) {
    throw new AtsError(
      'BLOCKED_BY_SECURITY_POLICY',
      'The Greenhouse Job Board API base URL must not contain credentials; no request was sent',
      'GREENHOUSE'
    );
  }
  const isOfficialHost =
    parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'boards-api.greenhouse.io';
  if (!isOfficialHost && !isLoopbackHostname(parsed.hostname)) {
    throw new AtsError(
      'BLOCKED_BY_SECURITY_POLICY',
      `The Greenhouse Job Board API base URL host "${parsed.hostname}" is not allowed (only the documented API host or loopback mock fixtures); no request was sent`,
      'GREENHOUSE'
    );
  }
  return raw.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Client-side validation (documented: Greenhouse does NOT do this for us)
// ---------------------------------------------------------------------------

/** A PII-free description of a validation violation. Field names only. */
export interface GreenhouseJobBoardViolation {
  field: string;
  problem: string;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function containsUrl(value: string): boolean {
  return /\b(https?:\/\/|www\.)\S+/i.test(value);
}

function attachmentViolations(
  field: string,
  attachment: GreenhouseJobBoardAttachment
): GreenhouseJobBoardViolation[] {
  const violations: GreenhouseJobBoardViolation[] = [];
  const extension = attachment.filename.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(extension)) {
    violations.push({
      field,
      problem: `file type ".${extension || '(none)'}" is not an allowed attachment type (pdf, doc, docx, txt, rtf)`,
    });
  }
  if (!attachment.contentBase64 || attachment.contentBase64.trim().length === 0) {
    violations.push({ field, problem: 'the file is empty (documented: files must be > 0 bytes)' });
  }
  return violations;
}

/**
 * Validate the documented request rules client-side BEFORE anything is
 * sent. Greenhouse explicitly does not reject applications missing
 * required fields, so this gate is what prevents silent partial
 * applications. Returns PII-free violations (field names and problems
 * only - never answer values).
 */
export function validateGreenhouseJobBoardApplication(
  input: GreenhouseJobBoardApplicationInput
): GreenhouseJobBoardViolation[] {
  const violations: GreenhouseJobBoardViolation[] = [];
  const byName = new Map<string, string | number | Array<string | number>>();
  for (const answer of input.answers) {
    if (!byName.has(answer.name)) byName.set(answer.name, answer.value);
  }

  for (const requiredName of ['first_name', 'last_name', 'email']) {
    const value = byName.get(requiredName);
    const text =
      value == null
        ? ''
        : (Array.isArray(value) ? value.join(' ') : String(value)).trim();
    if (!text) {
      violations.push({ field: requiredName, problem: 'is required by the Job Board API' });
    } else if (text.length > MAX_IDENTITY_FIELD_LENGTH) {
      violations.push({
        field: requiredName,
        problem: `must be at most ${MAX_IDENTITY_FIELD_LENGTH} characters`,
      });
    }
  }

  const email = byName.get('email');
  if (typeof email === 'string' && email.trim() && !looksLikeEmail(email.trim())) {
    violations.push({ field: 'email', problem: 'must be a valid email address' });
  }

  for (const noUrlName of ['first_name', 'last_name', 'phone']) {
    const value = byName.get(noUrlName);
    if (typeof value === 'string' && value.trim() && containsUrl(value)) {
      violations.push({ field: noUrlName, problem: 'must not contain a URL' });
    }
  }

  if (input.resume) {
    violations.push(...attachmentViolations('resume', input.resume));
  }
  if (input.coverLetter) {
    violations.push(...attachmentViolations('cover_letter', input.coverLetter));
  }
  return violations;
}

/**
 * Pure answer-coverage check against the documented question list (from
 * the Job method with `?questions=true`). Returns the NAMES of required
 * questions that have no answer - PII-free. This is the client-side
 * required-field validation the docs mandate ("Greenhouse will not reject
 * applications that are missing required fields").
 */
export function findUnansweredRequiredQuestions(
  questions: GreenhouseJobBoardQuestion[],
  answers: GreenhouseJobBoardAnswer[]
): string[] {
  const answered = new Set<string>();
  for (const answer of answers) {
    const text = Array.isArray(answer.value) ? answer.value.join(' ') : answer.value;
    if (text != null && String(text).trim().length > 0) answered.add(answer.name);
  }
  const missing: string[] = [];
  for (const question of questions ?? []) {
    if (!question.required) continue;
    // A question is satisfied when ANY of its fields has a non-empty
    // answer (documented: e.g. "Resume" accepts input_file OR textarea).
    const satisfied = (question.fields ?? []).some((field) => answered.has(field.name));
    if (!satisfied) {
      missing.push(question.fields?.[0]?.name ?? question.label);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Request building + submission
// ---------------------------------------------------------------------------

/** The documented JSON request body (attachments as base64 content). */
export function buildGreenhouseJobBoardRequestBody(
  input: GreenhouseJobBoardApplicationInput
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const answer of input.answers) {
    body[answer.name] = answer.value;
  }
  if (input.resume) {
    body.resume_content = input.resume.contentBase64;
    body.resume_content_filename = input.resume.filename;
  }
  if (input.coverLetter) {
    body.cover_letter_content = input.coverLetter.contentBase64;
    body.cover_letter_content_filename = input.coverLetter.filename;
  }
  if (input.mappedUrlToken) {
    body.mapped_url_token = input.mappedUrlToken;
  }
  return body;
}

/**
 * Extract a provider reference from the UNDOCUMENTED response body,
 * strictly. Only a scalar `id` or `application_id` that the provider
 * actually returned is stored: a finite number, or a short non-empty
 * string. Empty, malformed, or structured values never produce a
 * reference - nothing is ever invented, coerced, or picked from unrelated
 * fields. The first valid candidate wins (`id`, then `application_id`).
 */
export function extractGreenhouseJobBoardReference(responseBody: string): string | null {
  if (!responseBody || !responseBody.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as { id?: unknown; application_id?: unknown };
  for (const candidate of [record.id, record.application_id]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
    if (typeof candidate === 'string' && candidate.trim() && candidate.trim().length <= 255) {
      return candidate.trim();
    }
  }
  return null;
}

export interface GreenhouseJobBoardSubmissionOptions {
  /** The employer-issued Job Board API key (Basic Auth username, no password). */
  apiKey: string;
  boardToken: string;
  jobPostId: string;
  input: GreenhouseJobBoardApplicationInput;
  /** Test fixtures only: a loopback base URL. Omit in normal operation. */
  baseUrl?: string;
  /** Request timeout in ms (default 30s). After it fires the outcome is unknown. */
  timeoutMs?: number;
}

/**
 * Outcome of ONE Job Board API submission attempt.
 *
 *  - ACCEPTED: the provider answered 2xx to the documented submission
 *    endpoint (real provider evidence, an authenticated acceptance). The
 *    response body is not documented, so `reference` is only set when the
 *    provider actually returned one.
 *  - REFUSED: the provider answered 4xx and refused the application -
 *    definitive, NOTHING was submitted.
 *  - BLOCKED: client-side validation (or a missing API key) refused the
 *    attempt BEFORE any request was sent - definitive, nothing was sent.
 *
 * A THROWN AtsError always means the outcome is UNKNOWN
 * (`SUBMISSION_UNCONFIRMED`): the request may have reached the provider and
 * must never be retried blindly.
 */
export type GreenhouseJobBoardSubmissionResult =
  | { kind: 'ACCEPTED'; httpStatus: number; reference: string | null }
  | { kind: 'REFUSED'; httpStatus: number; detail: string }
  | { kind: 'BLOCKED'; violations: GreenhouseJobBoardViolation[] };

/**
 * Error codes that prove the request NEVER left this machine: the TCP
 * connection was never established (connection refused / connect timeout)
 * or the host name never resolved. A request at these boundaries cannot
 * have reached the provider, so its outcome is a KNOWN pre-transmission
 * failure - not an unknown one.
 */
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

/**
 * Submit ONE application through the documented Job Board API endpoint.
 *
 * Exactly one HTTP request is issued. There is no retry on any path - the
 * endpoint has no idempotency support, so a request that may have landed
 * must never be repeated from here (the caller's durable attempt ledger
 * owns single-attempt enforcement, and an unknown outcome blocks any new
 * attempt).
 */
export async function submitGreenhouseJobBoardApplication(
  options: GreenhouseJobBoardSubmissionOptions
): Promise<GreenhouseJobBoardSubmissionResult> {
  const base = resolveJobBoardApiBase(options.baseUrl);
  const target = `${base}/v1/boards/${encodeURIComponent(options.boardToken)}/jobs/${encodeURIComponent(
    options.jobPostId
  )}`;

  // Client-side validation BEFORE anything is sent (documented rule).
  const violations = validateGreenhouseJobBoardApplication(options.input);
  if (violations.length > 0) {
    return { kind: 'BLOCKED', violations };
  }
  if (!options.apiKey || options.apiKey.trim().length === 0) {
    return {
      kind: 'BLOCKED',
      violations: [
        {
          field: 'job_board_api_key',
          problem: 'no Job Board API key is configured (the employer-issued key is required)',
        },
      ],
    };
  }

  const body = buildGreenhouseJobBoardRequestBody(options.input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  let status = 0;
  let responseBody = '';
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Basic Auth: username is the API key, no password (documented).
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
    // A connection that was never established proves the request never
    // left this machine: a KNOWN pre-transmission failure (definitively
    // not submitted - retrying is safe). Everything else may or may not
    // have reached the provider: UNKNOWN outcome. Never retried.
    if (isDefinitelyNotTransmitted(err)) {
      throw new AtsError(
        'SUBMISSION_FAILED',
        `The Job Board API request was never transmitted (${
          err instanceof Error ? err.message : String(err)
        }); nothing was submitted`,
        'GREENHOUSE',
        err
      );
    }
    throw new AtsError(
      'SUBMISSION_UNCONFIRMED',
      `The Job Board API submission request outcome is unknown (the request may have reached the provider and must never be retried blindly): ${
        err instanceof Error ? err.message : String(err)
      }`,
      'GREENHOUSE',
      err
    );
  } finally {
    clearTimeout(timeout);
  }

  if (status >= 200 && status < 300) {
    // The response body is not documented - a 2xx without a parseable
    // reference is still provider acceptance, just without an id.
    return {
      kind: 'ACCEPTED',
      httpStatus: status,
      reference: extractGreenhouseJobBoardReference(responseBody),
    };
  }

  if (status >= 300 && status < 400) {
    // The provider answered with a redirect instead of accepting the
    // application at the documented endpoint. It was never followed, so
    // nothing was re-sent elsewhere - but whether the provider recorded
    // the application cannot be proven: UNKNOWN, never retried.
    throw new AtsError(
      'SUBMISSION_UNCONFIRMED',
      `The Job Board API answered HTTP ${status} (a redirect, which is never followed); the submission outcome cannot be proven and must never be retried blindly`,
      'GREENHOUSE'
    );
  }

  if (status >= 400 && status < 500) {
    // The provider refused the request (auth/validation): definitive -
    // nothing was submitted. The detail is PII-free (status only plus the
    // provider's own generic message, never answer values).
    return {
      kind: 'REFUSED',
      httpStatus: status,
      detail: `the Job Board API refused the application (HTTP ${status})`,
    };
  }

  // 5xx and anything else: the provider received the request but its
  // outcome cannot be proven either way. UNKNOWN - never retried blindly.
  throw new AtsError(
    'SUBMISSION_UNCONFIRMED',
    `The Job Board API answered HTTP ${status} without a verifiable outcome; the submission may or may not have been recorded and must never be retried blindly`,
    'GREENHOUSE'
  );
}

/**
 * Fetch the documented job application question list (Job method with
 * `?questions=true`). Public, unauthenticated GET - used for client-side
 * answer validation before submission. Read-only.
 */
export async function fetchGreenhouseJobBoardQuestions(options: {
  boardToken: string;
  jobPostId: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<GreenhouseJobBoardQuestion[]> {
  const base = resolveJobBoardApiBase(options.baseUrl);
  const target = `${base}/v1/boards/${encodeURIComponent(options.boardToken)}/jobs/${encodeURIComponent(
    options.jobPostId
  )}?questions=true`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      // Redirects are never followed - a redirect could point the read at
      // an internal host (SSRF) or non-documented content.
      redirect: 'manual',
    });
    if (!response.ok) {
      throw new AtsError(
        'INSPECTION_FAILED',
        response.status >= 300 && response.status < 400
          ? `The Job Board API question list answered a redirect (HTTP ${response.status}) which is never followed`
          : `The Job Board API question list could not be read (HTTP ${response.status})`,
        'GREENHOUSE'
      );
    }
    const parsed = (await response.json()) as { questions?: GreenhouseJobBoardQuestion[] };
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  } finally {
    clearTimeout(timeout);
  }
}
