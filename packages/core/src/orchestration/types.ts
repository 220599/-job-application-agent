import type { AutomationRun, ApplicationStatus } from '@jaa/database';

/**
 * Phase 13 - BullMQ application orchestration.
 *
 * PostgreSQL is the durable source of truth; BullMQ is only the asynchronous
 * execution mechanism. Job payloads carry identifiers only
 * (PreparationJobPayload in @jaa/shared) - the worker loads everything else
 * from the database. The lifecycle stops at FORM_INSPECTED: nothing here
 * fills answers, uploads resumes, solves CAPTCHAs, or submits applications.
 */

export type OrchestrationErrorCode =
  | 'APPLICATION_NOT_FOUND'
  | 'RESUME_NOT_APPROVED'
  | 'TAILORING_NOT_VALIDATED'
  | 'APPLICATION_TERMINAL'
  | 'APPLICATION_STATE_NOT_PREPARABLE'
  | 'APPLICATION_URL_MISSING'
  | 'INVALID_APPLICATION_URL'
  | 'UNSUPPORTED_ATS'
  | 'ENQUEUE_FAILED'
  | 'AUTOMATION_RUN_NOT_FOUND'
  | 'AUTOMATION_NOT_CANCELLABLE'
  | 'INVALID_JOB_PAYLOAD'
  | 'RUN_MISMATCH'
  | 'ADAPTER_NOT_FOUND'
  | 'DUPLICATE_PROVIDER'
  | 'BLOCKED_BY_SECURITY_POLICY'
  | 'INSPECTION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TRANSIENT_FAILURE'
  | 'PREPARATION_FAILED'
  // Phase 15A - submission gate + submission outcomes.
  | 'HUMAN_APPROVAL_REQUIRED'
  | 'APPLICATION_STATE_NOT_SUBMITTABLE'
  | 'SUBMISSION_OUTCOME_UNKNOWN'
  | 'REQUIRED_ANSWER_MISSING'
  | 'ANSWER_NEEDS_REVIEW'
  | 'ANSWER_INVALID'
  | 'SUBMISSION_FAILED'
  | 'CAPTCHA_DETECTED'
  | 'SECURITY_CHALLENGE';

export class OrchestrationError extends Error {
  constructor(
    public readonly code: OrchestrationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'OrchestrationError';
  }
}

export function isOrchestrationError(err: unknown): err is OrchestrationError {
  return err instanceof OrchestrationError;
}

/** Stable, single BullMQ queue for application preparation. */
export const PREPARATION_QUEUE_NAME = 'application-preparation';

/** Bounded retries with exponential backoff. Deterministic failures never retry. */
export const PREPARATION_MAX_ATTEMPTS = 3;
export const PREPARATION_BACKOFF_MS = 5_000;

/**
 * Phase 15A - stable BullMQ queue for mock application submission. Same
 * orchestration system, same identifiers-only payload contract
 * (PreparationJobPayload), same bounded retry policy - a separate lane so
 * preparation and submission jobs never interfere with each other.
 */
export const SUBMISSION_QUEUE_NAME = 'application-submission';

/** Bounded retries with exponential backoff. Unknown outcomes never retry. */
export const SUBMISSION_MAX_ATTEMPTS = 3;
export const SUBMISSION_BACKOFF_MS = 5_000;

/**
 * Application statuses a submission attempt may START from (fresh): only
 * APPROVED - the state produced exclusively by the explicit human approval
 * action. Everything else (including FORM_INSPECTED and FAILED) is blocked.
 */
export const SUBMITTABLE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'APPROVED',
];

/**
 * A RUNNING AutomationRun whose `updatedAt` is older than this is treated as
 * crashed (the worker died before finishing) and may be reclaimed. Workers
 * heartbeat `updatedAt` while they run, so live runs never look stale.
 */
export const DEFAULT_RUN_STALE_MS = 5 * 60_000;

/**
 * Application statuses that may be (re)queued for preparation. FAILED is
 * included: it records a failed attempt, not a terminal lifecycle outcome,
 * and Phase 13 never advances past FORM_INSPECTED.
 */
export const PREPARABLE_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'DISCOVERED',
  'MATCHED',
  'PREPARING',
  'FORM_INSPECTED',
  'FAILED',
];

/** Terminal lifecycle outcomes - never queued for preparation. */
export const TERMINAL_APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'SUBMITTING',
  'SUBMITTED',
  'WITHDRAWN',
  'REJECTED',
  'INTERVIEW',
  'OFFER',
];

/**
 * The safe, client-visible projection of an AutomationRun. Metadata is NOT
 * exposed (it may hold internal URLs); error text is redacted of credentials
 * and query strings. No BullMQ job objects, Redis details, or worker
 * internals ever cross this boundary.
 */
export interface SafeAutomationRunView {
  id: string;
  applicationId: string;
  provider: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Redact credentials and query strings from any error text before it is
 * persisted or returned. Messages may embed application URLs (which can carry
 * tokens in query parameters) - those must never reach logs or clients.
 */
export function safeErrorMessage(input: unknown): string {
  const raw =
    input instanceof Error
      ? input.message
      : typeof input === 'string'
        ? input
        : String(input);
  const redacted = raw
    // https://user:pass@host -> https://***@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1***@')
    // https://host/path?token=x -> https://host/path?…
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/gi, '$1?…')
    // Authorization: Bearer <jwt>
    .replace(/(\b(?:bearer|basic)\s+)[A-Za-z0-9+/._~=-]{8,}/gi, '$1***')
    // key=value style secrets in free text
    .replace(
      /\b(token|password|passwd|secret|api[-_]?key|authorization|cookie)\b(\s*[=:]\s*)\S+/gi,
      '$1$2***'
    );
  return redacted.slice(0, 500);
}

/** Project an AutomationRun onto its safe client-visible shape. */
export function safeAutomationRunView(run: AutomationRun): SafeAutomationRunView {
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  const errorCode = typeof meta['errorCode'] === 'string' ? meta['errorCode'] : null;
  return {
    id: run.id,
    applicationId: run.applicationId,
    provider: run.provider,
    status: run.status,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    errorCode,
    errorMessage: run.errorMessage ? safeErrorMessage(run.errorMessage) : null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}
