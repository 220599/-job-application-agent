import { prisma } from '@jaa/database';
import type { AutomationRun } from '@jaa/database';
import type { Prisma } from '@prisma/client';

/**
 * AutomationRun tracking for browser execution (introduced in Phase 6,
 * moved into packages/core in Phase 7 so the application preparation
 * service can reuse it with the correct dependency direction:
 * apps/api -> packages/core -> database).
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
 * AutomationRun rows are tied to an Application (applicationId is unique),
 * so there is at most one run row per application - re-inspection reuses
 * and resets the existing row instead of creating a duplicate.
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

/**
 * Reuse the single AutomationRun row for an application (applicationId is
 * unique) or create it. Re-running preparation resets the row to RUNNING.
 */
export async function getOrCreateAutomationRun(params: {
  userId: string;
  applicationId: string;
  provider?: string;
}): Promise<AutomationRun> {
  const existing = await prisma.automationRun.findUnique({
    where: { applicationId: params.applicationId },
  });
  if (existing) {
    return prisma.automationRun.update({
      where: { id: existing.id },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        completedAt: null,
        errorMessage: null,
        provider: params.provider ?? existing.provider,
      },
    });
  }
  return startAutomationRun(params);
}
