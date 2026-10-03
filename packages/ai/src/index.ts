/**
 * @jaa/ai - Pluggable, provider-independent AI abstraction.
 *
 * This package defines the seam between the application and any text
 * generation backend (OpenAI, Anthropic, a local model, or a test mock).
 * Higher layers (packages/core) depend ONLY on the `AiProvider` interface
 * below - never on a concrete vendor SDK.
 *
 * Design notes (Phase 10):
 *  - Nothing here calls the network by itself. A concrete provider is an
 *    object implementing `generate`; tests inject a mock provider so no real
 *    external AI call is ever made.
 *  - Failures are normalized into `AiError` with a stable `code` so callers
 *    can map them to structured application errors and review flags.
 *  - The higher-level answer contract (`AIResponse`) is re-exported from
 *    @jaa/shared so the answer service and providers share one shape.
 */

// The structured answer contract already defined in @jaa/shared.
export type { AIResponse } from '@jaa/shared';

/** Stable, structured failure codes for AI generation. */
export type AiErrorCode =
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_EMPTY_RESPONSE'
  | 'AI_INVALID_RESPONSE'
  | 'AI_REQUEST_FAILED';

/** Normalized AI failure. Carries a stable code and never leaks secrets. */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly provider?: string;
  readonly underlying?: unknown;

  constructor(
    code: AiErrorCode,
    message: string,
    options?: { provider?: string; underlying?: unknown }
  ) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.provider = options?.provider;
    this.underlying = options?.underlying;
  }
}

export interface AiGenerateOptions {
  /** Upper bound on generated tokens (advisory). */
  maxTokens?: number;
  /** Sampling temperature (advisory). */
  temperature?: number;
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
}

export interface AiGenerateRequest {
  /**
   * The full prompt (system + user content already composed by the caller).
   * Callers are responsible for grounding and privacy - see packages/core.
   */
  prompt: string;
  options?: AiGenerateOptions;
}

export interface AiGenerateResult {
  /** Raw generated text. May be empty - callers validate. */
  text: string;
  /** Identifier of the provider that produced the text. */
  provider: string;
  /** Optional model identifier for provenance. */
  model?: string;
}

/**
 * A pluggable text generation provider. Implement this to integrate a real
 * model backend. `generate` should reject with `AiError` on failure.
 */
export interface AiProvider {
  readonly name: string;
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
}

// ============================================================================
// Mock provider (tests / local development)
// ============================================================================

/**
 * A deterministic in-memory provider. It records every request so tests can
 * assert on prompt content (grounding, job context, anti-fabrication) and it
 * can simulate failures (timeouts, rate limits, empty/invalid output) via the
 * `handler`. No network access, no external calls.
 */
export interface MockAiProvider extends AiProvider {
  /** Every request received, in order. */
  readonly calls: AiGenerateRequest[];
  /** The prompts received, in order (convenience for assertions). */
  readonly prompts: string[];
}

export interface MockAiProviderOptions {
  name?: string;
  /**
   * Produce the response text for a request. Return a string (or a promise of
   * one). Throw an `AiError` to simulate a failure. When omitted, the provider
   * returns the configured `defaultText` for every request.
   */
  handler?: (request: AiGenerateRequest) => string | Promise<string>;
  /** Text returned when no handler is provided. */
  defaultText?: string;
}

export function createMockAiProvider(options: MockAiProviderOptions = {}): MockAiProvider {
  const name = options.name ?? 'mock-ai';
  const calls: AiGenerateRequest[] = [];
  const handler = options.handler;
  const defaultText = options.defaultText ?? 'Mock AI response.';

  return {
    name,
    calls,
    get prompts() {
      return calls.map((c) => c.prompt);
    },
    async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
      calls.push(request);
      const text = handler ? await handler(request) : defaultText;
      return { text, provider: name, model: 'mock-model' };
    },
  };
}

/** A provider that always fails with `AI_PROVIDER_UNAVAILABLE`. */
export function createUnavailableAiProvider(name = 'unavailable-ai'): AiProvider {
  return {
    name,
    async generate(): Promise<AiGenerateResult> {
      throw new AiError('AI_PROVIDER_UNAVAILABLE', 'No AI provider is configured', {
        provider: name,
      });
    },
  };
}

// ============================================================================
// Default provider registry
// ============================================================================

// The process-wide provider used when a caller does not inject one. Defaults to
// null (no provider), which surfaces as a structured `AI_PROVIDER_UNAVAILABLE`
// failure that marks answers for review instead of fabricating. Wire a real
// provider here at startup without changing call sites.
let defaultProvider: AiProvider | null = null;

export function setDefaultAiProvider(provider: AiProvider | null): void {
  defaultProvider = provider;
}

export function getDefaultAiProvider(): AiProvider | null {
  return defaultProvider;
}
