import { prisma } from '@jaa/database';
import type { AutomationRun } from '@jaa/database';
import type { Prisma } from '@prisma/client';

/**
 * Phase 6 - AutomationRun tracking for browser execution.
 *
 * Uses the EXISTING AutomationRun model (no schema changes):
 *   id, userId, applicationId (unique), provider, status
 *   (QUEUED/RUNNING/PAUSED/COMPLETED/FAILED/CANCELLED),
 *   startedAt, completedAt, errorMessage, metadata (Json).
 *
 * The "current URL" requirement is recorded inside `metadata` as
 * `lastUrl` (+ a capped `urlHistory`), since the browser layer knows the
 * URL at runtime and metadata is the schema's extension point.
 *
 * AutomationRun rows are tied to an Application (Phase 7+ will create
 * applications before starting runs), so this service is provided for the
 * later phases and is intentionally NOT wired to the Phase 6 foundation
 * tests, which run without a database.
 */

const MAX_URL_HISTORY = 20;

export interface StartAutomationRunParams {
  userId: string;
  applicationId: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

/** Create a run in RUNNING state with startedAt = now. */
export async function startAutomationRun(params: StartAutomationRunParams): Promise<AutomationRun> {
  return prisma.automationRun.create({
    data: {
      userId: params.userId,
      applicationId: params.applicationId,
      provider: params.provider ?? 'PLAYWRIGHT',
      status: 'RUNNING',
      startedAt: new Date(),
      metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/** Record the current browser URL on the run (metadata.lastUrl + urlHistory). */
export async function recordRunCurrentUrl(runId: string, url: string): Promise<AutomationRun> {
  const run = await prisma.automationRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`AUTOMATION_RUN_NOT_FOUND: ${runId}`);

  const existing = (run.metadata ?? {}) as Record<string, unknown>;
  const history = Array.isArray(existing.urlHistory) ? existing.urlHistory : [];
  const urlHistory = [...history, { url, at: new Date().toISOString() }].slice(-MAX_URL_HISTORY);

  return prisma.automationRun.update({
    where: { id: runId },
    data: {
      metadata: {
        ...existing,
        lastUrl: url,
        urlHistory,
      } as Prisma.InputJsonValue,
    },
  });
}

export interface CompleteAutomationRunParams {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

/** Finish a run: completedAt = now, final status and optional error info. */
export async function completeAutomationRun(
  runId: string,
  params: CompleteAutomationRunParams
): Promise<AutomationRun> {
  const run = await prisma.automationRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`AUTOMATION_RUN_NOT_FOUND: ${runId}`);

  const existing = (run.metadata ?? {}) as Record<string, unknown>;
  return prisma.automationRun.update({
    where: { id: runId },
    data: {
      status: params.status,
      completedAt: new Date(),
      errorMessage: params.errorMessage ?? run.errorMessage,
      metadata: params.metadata
        ? ({ ...existing, ...params.metadata } as Prisma.InputJsonValue)
        : (existing as Prisma.InputJsonValue),
    },
  });
}
