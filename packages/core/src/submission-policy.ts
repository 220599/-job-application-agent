import { validatePublicHttpUrl } from '@jaa/browser';

import { OrchestrationError } from './orchestration/types';

/**
 * Phase 15B - submission target policy (server-side capability control).
 *
 * This is a LEAF module (it imports nothing from application-submission or
 * submission-eligibility) so both the API gate and the core submission
 * workflow can share one policy without an import cycle.
 *
 * Two submission modes exist, decided ONLY by the server from the target URL:
 *
 *  - MOCK  : a LOOPBACK target. Requires the Phase 15A mock opt-in
 *            (`JAA_ALLOW_MOCK_SUBMISSION=true`) and is never allowed in
 *            production. This is unchanged from Phase 15A.
 *  - REAL  : a non-loopback target. Requires the Phase 15B capability flag
 *            (`JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED=true`), must be a
 *            recognized GREENHOUSE application URL, and must pass the
 *            public-URL (SSRF) policy. Lever stays mock-only: real Lever
 *            submission is Phase 15C and is refused here.
 *
 * The capability is controlled ONLY by the server environment. A client can
 * never enable it: no request field, header, or body value is consulted.
 * Real submission is disabled by default and stays disabled until the flag
 * is explicitly set.
 */

/** The single server-side switch for controlled real Greenhouse submission. */
export const REAL_GREENHOUSE_SUBMISSION_FLAG = 'JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED';

/** The only provider allowed a real (non-loopback) submission in 15B. */
export const REAL_SUBMISSION_PROVIDER = 'GREENHOUSE';

export type SubmissionTargetMode = 'MOCK' | 'REAL';

/**
 * True when the URL targets a loopback address - the only place a mock ATS
 * may live. Local mock servers bind 127.0.0.0/8 or ::1 and never a routable
 * interface.
 */
export function isLoopbackUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The mock-only submission policy (Phase 15A, unchanged). This is a
 * structural guarantee that mock submission can never reach a real
 * application:
 *
 *  - never in production (no opt-in can enable it there);
 *  - only with an explicit `JAA_ALLOW_MOCK_SUBMISSION=true` opt-in (local
 *    test runs set it; production code never does);
 *  - only to LOOPBACK mock ATS hosts.
 */
export function assertMockSubmissionTarget(applicationUrl: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new OrchestrationError(
      'BLOCKED_BY_SECURITY_POLICY',
      'Submission is disabled in production; no application can ever be submitted automatically'
    );
  }
  if (process.env.JAA_ALLOW_MOCK_SUBMISSION !== 'true') {
    throw new OrchestrationError(
      'BLOCKED_BY_SECURITY_POLICY',
      'Submission is disabled: this phase only supports mock submission (JAA_ALLOW_MOCK_SUBMISSION is not enabled)'
    );
  }
  if (!isLoopbackUrl(applicationUrl)) {
    throw new OrchestrationError(
      'BLOCKED_BY_SECURITY_POLICY',
      'Submission only targets local loopback mock ATS servers; real ATS URLs are never submitted'
    );
  }
}

/**
 * Real Greenhouse submission capability (Phase 15B). Controlled ONLY by the
 * server environment - disabled by default, and never enabled by a client.
 */
export function isRealGreenhouseSubmissionEnabled(): boolean {
  return process.env[REAL_GREENHOUSE_SUBMISSION_FLAG] === 'true';
}

/** Fail closed when the real-submission capability is not explicitly enabled. */
export function assertRealGreenhouseSubmissionEnabled(): void {
  if (!isRealGreenhouseSubmissionEnabled()) {
    throw new OrchestrationError(
      'BLOCKED_BY_SECURITY_POLICY',
      `Real Greenhouse submission is disabled: set ${REAL_GREENHOUSE_SUBMISSION_FLAG}=true on the server to enable it`
    );
  }
}

/**
 * Decide the submission mode from the target URL alone. Loopback is always
 * the mock boundary; anything else is a real target and is only reachable
 * under the real Greenhouse capability.
 */
export function resolveSubmissionMode(applicationUrl: string): SubmissionTargetMode {
  return isLoopbackUrl(applicationUrl) ? 'MOCK' : 'REAL';
}

/**
 * The real-submission target policy (Phase 15B). A real target must:
 *
 *  1. have the real Greenhouse capability explicitly enabled (fail closed);
 *  2. be a recognized GREENHOUSE application URL (Lever is mock-only here);
 *  3. never be loopback (that is the mock boundary, not a real target);
 *  4. pass the public-URL (SSRF) policy: no localhost, loopback, private,
 *     link-local, or metadata addresses, and no unsafe protocol.
 *
 * This deliberately has NO "allow any URL" escape hatch. The only relaxation
 * a future test target may need is provider-specific (a recognized Greenhouse
 * host), never a general bypass of these rules.
 */
export function assertRealGreenhouseSubmissionTarget(
  applicationUrl: string,
  provider: string | null | undefined
): void {
  assertRealGreenhouseSubmissionEnabled();

  if (provider !== REAL_SUBMISSION_PROVIDER) {
    throw new OrchestrationError(
      'BLOCKED_BY_SECURITY_POLICY',
      'Real submission is only permitted for Greenhouse; this target is not a recognized Greenhouse application URL'
    );
  }

  if (isLoopbackUrl(applicationUrl)) {
    throw new OrchestrationError(
      'BLOCKED_BY_SECURITY_POLICY',
      'Real submission must target a real Greenhouse host, never a loopback mock server'
    );
  }

  // SSRF: the same public-URL policy the browser enforces on navigation.
  // Never relaxed for the real path - private/loopback/link-local/metadata
  // targets and unsafe protocols are refused outright.
  const check = validatePublicHttpUrl(applicationUrl, { allowPrivate: false });
  if (!check.valid) {
    throw new OrchestrationError(
      'BLOCKED_BY_SECURITY_POLICY',
      `Real submission target rejected by URL safety policy: ${check.reason}`
    );
  }
}

/**
 * Enforce the full submission target policy and return the mode. `provider`
 * must already be resolved from the ATS registry (Greenhouse-only is enforced
 * against it for real targets).
 */
export function assertSubmissionTarget(
  applicationUrl: string,
  provider: string | null | undefined
): SubmissionTargetMode {
  const mode = resolveSubmissionMode(applicationUrl);
  if (mode === 'MOCK') {
    assertMockSubmissionTarget(applicationUrl);
    return 'MOCK';
  }
  assertRealGreenhouseSubmissionTarget(applicationUrl, provider);
  return 'REAL';
}
