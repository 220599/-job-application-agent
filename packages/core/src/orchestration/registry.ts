import { createDefaultAtsRegistry, type AtsRegistry } from '@jaa/ats';
import { registerGreenhouseAdapter } from '@jaa/greenhouse';
import { registerLeverAdapter } from '@jaa/lever';

/**
 * Phase 13 - registry bootstrap for orchestration.
 *
 * The registry itself stays provider-agnostic (@jaa/ats); this is the single
 * place that wires the built-in provider adapters (Greenhouse, Lever) for the
 * API eligibility checks and the worker. Tests pass their own registry with
 * mock-server hosts (extraBoardHosts) instead.
 */
export interface PreparationRegistryOptions {
  /** Extra hostnames adapters may treat as provider boards (test mirrors). */
  extraBoardHosts?: string[];
}

export function createPreparationRegistry(
  options?: PreparationRegistryOptions
): AtsRegistry {
  const registry = createDefaultAtsRegistry();
  const adapterOptions = options?.extraBoardHosts?.length
    ? { extraBoardHosts: options.extraBoardHosts }
    : undefined;
  registerGreenhouseAdapter(registry, adapterOptions);
  registerLeverAdapter(registry, adapterOptions);
  return registry;
}
