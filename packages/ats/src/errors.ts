/**
 * Phase 7 - Provider-independent ATS error model.
 *
 * Higher layers see AtsError with a machine-readable code; raw browser
 * internals (Playwright) are never exposed. The underlying cause is
 * preserved for debugging when available.
 */

export type AtsErrorCode =
  | 'UNSUPPORTED_ATS'
  | 'ADAPTER_NOT_FOUND'
  | 'DUPLICATE_PROVIDER'
  | 'INVALID_APPLICATION_URL'
  | 'PAGE_NOT_RECOGNIZED'
  | 'INSPECTION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'BLOCKED_BY_SECURITY_POLICY';

export class AtsError extends Error {
  constructor(
    public code: AtsErrorCode,
    message: string,
    public provider?: string,
    public readonly underlying?: unknown
  ) {
    super(message);
    this.name = 'AtsError';
  }
}

export function isAtsError(err: unknown): err is AtsError {
  return err instanceof AtsError;
}

/**
 * Map a @jaa/browser error onto the ATS error model. Raw Playwright
 * internals never leak - only the browser layer's own typed errors are
 * translated, and their message is preserved as the underlying cause.
 */
export function atsErrorFromBrowserError(
  err: unknown,
  provider: string,
  url: string
): AtsError {
  const message = err instanceof Error ? err.message : String(err);
  // Import lazily to avoid a hard runtime coupling in error paths
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  if (code === 'URL_BLOCKED') {
    return new AtsError(
      'BLOCKED_BY_SECURITY_POLICY',
      'Navigation blocked by the browser security policy (SSRF protection)',
      provider,
      err
    );
  }
  if (code === 'INVALID_URL') {
    return new AtsError('INVALID_APPLICATION_URL', message, provider, err);
  }
  return new AtsError('INSPECTION_FAILED', message, provider, err);
}
