import type { AtsAdapter } from './types';
import { AtsError } from './errors';

/**
 * Phase 7 - ATS adapter registry.
 *
 * Deterministic, provider-agnostic lookup. There is no Greenhouse (or any
 * other provider) knowledge in here - providers register themselves, so
 * future packages (Lever, Workday, Ashby...) plug in without changes to
 * this file.
 */
export class AtsRegistry {
  /** Map preserves insertion order -> deterministic findForUrl iteration. */
  private readonly adapters = new Map<string, AtsAdapter>();

  /**
   * Register an adapter. Duplicate provider identifiers are rejected -
   * silent overrides would make lookup order unpredictable.
   */
  register(adapter: AtsAdapter): void {
    const key = adapter.provider.toUpperCase();
    if (this.adapters.has(key)) {
      throw new AtsError(
        'DUPLICATE_PROVIDER',
        `An adapter for provider "${adapter.provider}" is already registered`,
        adapter.provider
      );
    }
    this.adapters.set(key, adapter);
  }

  /** Look up an adapter by its provider identifier. Case-insensitive. */
  get(provider: string): AtsAdapter {
    const adapter = this.adapters.get(provider.toUpperCase());
    if (!adapter) {
      throw new AtsError(
        'ADAPTER_NOT_FOUND',
        `No ATS adapter registered for provider "${provider}". Registered: ${this.list().join(', ') || '(none)'}`,
        provider
      );
    }
    return adapter;
  }

  /**
   * Find the first registered adapter that can handle the URL. Iteration
   * follows registration order, so lookup is deterministic. Returns null
   * when no adapter claims the URL (callers decide how to surface that).
   */
  findForUrl(url: string): AtsAdapter | null {
    for (const adapter of this.adapters.values()) {
      try {
        if (adapter.canHandle(url)) return adapter;
      } catch {
        // A broken canHandle must not break the whole lookup; treat as "no".
        continue;
      }
    }
    return null;
  }

  has(provider: string): boolean {
    return this.adapters.has(provider.toUpperCase());
  }

  /** Registered provider identifiers in registration order. */
  list(): string[] {
    return [...this.adapters.keys()];
  }
}

/**
 * Create an empty registry. Deliberately no built-in providers: provider
 * packages (Greenhouse in Phase 8) register themselves, keeping the
 * generic package free of provider logic.
 */
export function createDefaultAtsRegistry(): AtsRegistry {
  return new AtsRegistry();
}
