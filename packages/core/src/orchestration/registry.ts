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

/**
 * TEST-ONLY escape hatch (Phase 14): extra hostnames the adapters may treat
 * as provider boards, read from `JAA_TEST_EXTRA_BOARD_HOSTS` (comma
 * separated, all providers) and/or `JAA_TEST_EXTRA_BOARD_HOSTS_GREENHOUSE` /
 * `JAA_TEST_EXTRA_BOARD_HOSTS_LEVER` (comma separated, one provider). The
 * per-provider form exists because URL recognition is first-match: without
 * it a single shared host list would make the first registered adapter claim
 * every test-mirror URL (Greenhouse would eat Lever's mock pages). This
 * exists so the end-to-end tests can drive the REAL API and worker code
 * paths against local mock ATS servers without passing a custom registry
 * around.
 *
 * Safety:
 *  - never honored when NODE_ENV=production;
 *  - empty by default - production behavior is unchanged;
 *  - it only affects URL RECOGNITION (which adapter claims a URL). It does
 *    NOT relax the @jaa/browser SSRF policy: navigation to private/loopback
 *    hosts still requires the separate, explicit `allowPrivateUrls` opt-in
 *    and is blocked by default everywhere.
 */
function testOnlyExtraBoardHosts(provider: 'GREENHOUSE' | 'LEVER'): string[] {
  if (process.env.NODE_ENV === 'production') return [];
  const raw = [
    process.env.JAA_TEST_EXTRA_BOARD_HOSTS,
    process.env[`JAA_TEST_EXTRA_BOARD_HOSTS_${provider}`],
  ]
    .filter(Boolean)
    .join(',');
  if (!raw) return [];
  return raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function createPreparationRegistry(
  options?: PreparationRegistryOptions
): AtsRegistry {
  const registry = createDefaultAtsRegistry();
  const shared = options?.extraBoardHosts ?? [];
  const greenhouseHosts = [
    ...new Set([...shared, ...testOnlyExtraBoardHosts('GREENHOUSE')]),
  ];
  const leverHosts = [...new Set([...shared, ...testOnlyExtraBoardHosts('LEVER')])];
  registerGreenhouseAdapter(
    registry,
    greenhouseHosts.length ? { extraBoardHosts: greenhouseHosts } : undefined
  );
  registerLeverAdapter(
    registry,
    leverHosts.length ? { extraBoardHosts: leverHosts } : undefined
  );
  return registry;
}
