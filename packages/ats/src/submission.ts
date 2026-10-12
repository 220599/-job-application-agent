import type { AtsSecurityChallengeKind, AtsSubmissionResult } from './types';

/**
 * Phase 15A - MOCK submission envelope helpers.
 *
 * The Phase 15A submission boundary talks to local mock ATS servers only
 * (enforced by the core submission policy: loopback targets, explicit opt-in
 * flag, never in production). The request that reaches the mock ATS carries
 * IDENTIFIERS AND COUNTS ONLY - never answer text, never resume content,
 * never candidate PII. This keeps the strongest possible safety property:
 * even the recorded request bodies on the mock ATS contain no candidate
 * data.
 *
 * The request is issued from inside the real browser page through the
 * public `JaaPage.evaluate` API, so the full production path stays intact:
 * adapter -> @jaa/browser (SSRF-validated navigation) -> mock ATS.
 */

export const MOCK_SUBMISSION_KIND = 'MOCK_SUBMISSION';

/** Identifiers-only submission envelope. Strictly no candidate data. */
export interface MockSubmissionEnvelope {
  kind: typeof MOCK_SUBMISSION_KIND;
  applicationId: string;
  submissionAttemptId: string;
  provider: string;
  fieldCount: number;
  requiredAnswerCount: number;
}

/** Structured result of the in-page submission request. */
export interface MockSubmissionResponse {
  ok: boolean;
  status: number;
  body: string;
  /** Set when the request itself failed - the outcome is UNKNOWN. */
  networkError?: string | null;
}

/**
 * Build a fully self-contained script for `JaaPage.evaluate` (which passes
 * no arguments to the evaluated function). The script POSTs the envelope to
 * the application form's action URL (same origin) and returns the response
 * status and body. It never reads or transmits candidate data.
 */
export function buildMockSubmissionScript(
  formSelector: string | null,
  envelope: MockSubmissionEnvelope
): string {
  return `(async function (formSelector, envelope) {
  var form = formSelector ? document.querySelector(formSelector) : null;
  var action = form && form.action ? form.action : window.location.href;
  try {
    var res = await fetch(action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope)
    });
    var text = '';
    try { text = await res.text(); } catch (e) { text = ''; }
    return { ok: res.ok, status: res.status, body: String(text).slice(0, 4000), networkError: null };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: '',
      networkError: String((err && err.message) || err)
    };
  }
})(${JSON.stringify(formSelector)}, ${JSON.stringify(envelope)})`;
}

export type MockSubmissionParseResult =
  | { kind: 'SUBMITTED'; confirmationId: string; httpStatus: number }
  | { kind: 'REJECTED'; httpStatus: number }
  | { kind: 'UNCONFIRMED'; reason: string };

/**
 * Interpret the submission response.
 *
 *  - a verifiable 2xx confirmation  -> SUBMITTED;
 *  - any HTTP refusal (>= 400)      -> REJECTED (definitively not submitted);
 *  - a network failure, or a 2xx response that is NOT the expected
 *    confirmation                    -> UNCONFIRMED: the request may have
 *    been accepted, so the outcome must never be retried blindly.
 */
export function parseMockSubmissionResponse(
  res: MockSubmissionResponse
): MockSubmissionParseResult {
  if (res.networkError || res.status === 0) {
    return {
      kind: 'UNCONFIRMED',
      reason: res.networkError
        ? `the submission request failed in transit (${res.networkError})`
        : 'no response was received for the submission request',
    };
  }
  if (res.status >= 200 && res.status < 300) {
    try {
      const parsed = JSON.parse(res.body) as { ok?: unknown; confirmationId?: unknown };
      if (
        parsed &&
        parsed.ok === true &&
        typeof parsed.confirmationId === 'string' &&
        parsed.confirmationId.trim().length > 0
      ) {
        return {
          kind: 'SUBMITTED',
          confirmationId: parsed.confirmationId.trim(),
          httpStatus: res.status,
        };
      }
    } catch {
      // fall through to UNCONFIRMED
    }
    return {
      kind: 'UNCONFIRMED',
      reason: `the ATS answered HTTP ${res.status} without a verifiable confirmation`,
    };
  }
  if (res.status >= 400) {
    return { kind: 'REJECTED', httpStatus: res.status };
  }
  return { kind: 'UNCONFIRMED', reason: `unexpected HTTP ${res.status} for a submission request` };
}

/** Map a DOM-scan challenge marker onto the provider-neutral challenge kind. */
export function challengeKindFor(detail: string): AtsSecurityChallengeKind {
  const d = detail.trim().toLowerCase();
  if (d === 'h-captcha' || d === 'g-recaptcha' || d === 'turnstile') return 'CAPTCHA';
  if (d === 'mfa' || d === 'two-factor') return 'MFA';
  if (d === 'bot-challenge') return 'BOT_CHALLENGE';
  return 'SECURITY_CHALLENGE';
}

/**
 * True when a submission result was accepted with a verifiable provider
 * confirmation. Nothing is ever faked - a submission is only "verified" when
 * the provider gave real evidence of success:
 *
 *  - MOCK / provider-id path: a non-empty confirmation id; or
 *  - REAL path: a confirmed provider id, a confirmed success page
 *    (form gone + explicit application-received confirmation), or an
 *    HTTP_ACCEPTED confirmation.
 *
 * HTTP_ACCEPTED is accepted only as the documented contract's own success
 * signal: a documented submission endpoint answered 2xx to the
 * authenticated submission request. Where a provider documents a stronger
 * confirmation (an id, a confirmation page) that stronger evidence is used
 * instead and a 2xx WITHOUT it is NOT verified - see
 * {@link parseMockSubmissionResponse}, which treats a 2xx without the
 * documented confirmation body as UNCONFIRMED.
 */
export function isVerifiedSubmission(result: AtsSubmissionResult): boolean {
  if (result.outcome !== 'SUBMITTED') return false;
  if (
    typeof result.externalApplicationId === 'string' &&
    result.externalApplicationId.trim().length > 0
  ) {
    return true;
  }
  const confirmation = result.confirmation;
  if (!confirmation) return false;
  if (confirmation.method === 'PROVIDER_ID') {
    return (
      typeof confirmation.reference === 'string' && confirmation.reference.trim().length > 0
    );
  }
  if (confirmation.method === 'HTTP_ACCEPTED') {
    // The 2xx response to the documented submission endpoint IS the
    // documented success signal (the response body is undocumented, so an
    // id can never be required). Produced only from a real 2xx.
    return true;
  }
  // SUCCESS_PAGE: the confirmed success-page URL is the real evidence.
  return typeof confirmation.url === 'string' && confirmation.url.trim().length > 0;
}
