import { prisma } from '@jaa/database';
import type { ApplicationStatus } from '@jaa/database';
import type { Prisma } from '@prisma/client';
import { launchBrowser } from '@jaa/browser';
import type { JaaBrowserContext } from '@jaa/browser';
import { AtsError, type AtsApplicationInspection, type AtsRegistry } from '@jaa/ats';

import { getOrCreateAutomationRun, recordRunCurrentUrl, completeAutomationRun } from './automation-tracking';

/**
 * Phase 7 - Application preparation workflow (packages/core).
 *
 * Receives an Application, resolves its ATS adapter from the registry,
 * drives an isolated browser context through the public @jaa/browser API,
 * inspects the application page, persists ApplicationQuestion records
 * (idempotently), and progresses the application status using the existing
 * Prisma ApplicationStatus enum - never beyond FORM_INSPECTED.
 *
 * Not done here (later phases): field mapping (9), AI answers (10),
 * resume tailoring (11), review UI (12), orchestration (13), submission.
 */

export interface PrepareApplicationParams {
  applicationId: string;
  registry: AtsRegistry;
  headless?: boolean;
  /** Test/dev only: allows loopback mock ATS servers. Default false. */
  allowPrivateUrls?: boolean;
}

export interface PrepareApplicationResult {
  applicationId: string;
  /** Final ApplicationStatus after preparation (never beyond FORM_INSPECTED). */
  status: ApplicationStatus;
  inspection: AtsApplicationInspection | null;
  /** Number of NEW ApplicationQuestion rows created (deduped on re-runs). */
  questionsPersisted: number;
  automationRunId: string;
  provider: string;
}

/** Statuses from which preparation (re-)inspection is allowed. */
const PREPARABLE_STATUSES: ApplicationStatus[] = [
  'DISCOVERED',
  'MATCHED',
  'PREPARING',
  'FORM_INSPECTED',
];

export async function prepareApplication(params: PrepareApplicationParams): Promise<PrepareApplicationResult> {
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { job: true },
  });
  if (!application) {
    throw new Error(`APPLICATION_NOT_FOUND: ${params.applicationId}`);
  }
  if (!PREPARABLE_STATUSES.includes(application.status)) {
    throw new Error(
      `INVALID_APPLICATION_STATUS: ${application.status} cannot be prepared (allowed: ${PREPARABLE_STATUSES.join(', ')})`
    );
  }

  // 0. The application must know where to apply.
  if (!application.applicationUrl) {
    throw new Error(
      `APPLICATION_URL_MISSING: application ${application.id} has no application URL`
    );
  }
  const applicationUrl: string = application.applicationUrl;

  // 1. Resolve the ATS adapter (provider-independent, via the registry).
  //    Resolution happens INSIDE the guarded scope: an unsupported ATS is a
  //    preparation failure and must leave the same audit trail (FAILED
  //    status, ERROR event, AutomationRun) as any other failure.
  let adapter: import('@jaa/ats').AtsAdapter | null = null;
  let run: Awaited<ReturnType<typeof getOrCreateAutomationRun>> | null = null;
  let browserContext: JaaBrowserContext | null = null;
  let ownedContext = false;

  try {
    adapter = params.registry.findForUrl(applicationUrl);
    if (!adapter) {
      // Create the run audit trail even for unsupported providers.
      run = await getOrCreateAutomationRun({
        userId: application.userId,
        applicationId: application.id,
        provider: 'UNKNOWN',
      });
      throw new AtsError(
        'UNSUPPORTED_ATS',
        `No ATS adapter can handle application URL ${applicationUrl}`,
        undefined
      );
    }

  // 2. AutomationRun: exactly one row per application (applicationId unique).
  run = await getOrCreateAutomationRun({
    userId: application.userId,
    applicationId: application.id,
    provider: adapter.provider,
  });

  // 3. Move the application into PREPARING with an audit event.
  await prisma.application.update({
    where: { id: application.id },
    data: { status: 'PREPARING' },
  });
  await prisma.applicationEvent.create({
    data: {
      applicationId: application.id,
      userId: application.userId,
      eventType: 'FORM_OPENED',
      status: 'PREPARING',
      message: `Preparing application via ${adapter.provider}`,
      metadata: { provider: adapter.provider, url: applicationUrl },
    },
  });

  // 4. Browser context through the public @jaa/browser API only.
  const browser = await launchBrowser({
      headless: params.headless,
      allowPrivateUrls: params.allowPrivateUrls,
    });
    browserContext = await browser.createContext({ allowPrivateUrls: params.allowPrivateUrls });
    ownedContext = true;
    const page = await browserContext.createPage();
    await recordRunCurrentUrl(run.id, applicationUrl);

    // 5. Inspect via the generic adapter contract.
    const inspection = await adapter.inspectApplication({
      url: applicationUrl,
      page,
      browserContext,
      applicationId: application.id,
      userId: application.userId,
      jobId: application.jobId,
      metadata: { provider: adapter.provider },
    });
    await recordRunCurrentUrl(run.id, inspection.url);

    // 6. Persist ApplicationQuestion rows (idempotent - no duplicates).
    let questionsPersisted = 0;
    for (const field of inspection.fields) {
      const existing = field.externalFieldId
        ? await prisma.applicationQuestion.findFirst({
            where: { applicationId: application.id, externalFieldId: field.externalFieldId },
          })
        : await prisma.applicationQuestion.findFirst({
            where: {
              applicationId: application.id,
              normalizedLabel: field.normalizedLabel ?? null,
              fieldType: field.type,
            },
          });
      if (existing) continue;

      await prisma.applicationQuestion.create({
        data: {
          applicationId: application.id,
          externalFieldId: field.externalFieldId ?? null,
          label: field.label,
          normalizedLabel: field.normalizedLabel ?? null,
          fieldType: field.type,
          required: field.required,
          options: (field.options ?? undefined) as Prisma.InputJsonValue | undefined,
          section: field.section ?? undefined,
          locator: (field.locator ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      questionsPersisted += 1;
    }

    // 7. Progress status - Phase 7 stops at FORM_INSPECTED. A page that is
    // not a recognized form stays PREPARING with warnings recorded.
    const finalStatus: ApplicationStatus = inspection.isApplicationForm
      ? 'FORM_INSPECTED'
      : 'PREPARING';
    await prisma.application.update({
      where: { id: application.id },
      data: { status: finalStatus },
    });
    await prisma.applicationEvent.create({
      data: {
        applicationId: application.id,
        userId: application.userId,
        eventType: 'FORM_INSPECTED',
        status: finalStatus,
        message: `Inspected ${inspection.fields.length} field(s) via ${adapter.provider}`,
        metadata: {
          provider: adapter.provider,
          fieldCount: inspection.fields.length,
          isApplicationForm: inspection.isApplicationForm,
          warnings: inspection.warnings,
        },
      },
    });

    // 8. AutomationRun bookkeeping (URL/lifecycle only - no secrets).
    await completeAutomationRun(run.id, {
      status: 'COMPLETED',
      metadata: {
        provider: adapter.provider,
        lastUrl: inspection.url,
        fieldCount: inspection.fields.length,
      },
    });

    return {
      applicationId: application.id,
      status: finalStatus,
      inspection,
      questionsPersisted,
      automationRunId: run.id,
      provider: adapter.provider,
    };
  } catch (err) {
    // Deterministic failure path: FAILED status, ERROR event, failed run.
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof AtsError ? err.code : 'INSPECTION_FAILED';
    const failedProvider = adapter?.provider ?? 'UNKNOWN';
    await prisma.application
      .update({ where: { id: application.id }, data: { status: 'FAILED' } })
      .catch(() => undefined);
    await prisma.applicationEvent
      .create({
        data: {
          applicationId: application.id,
          userId: application.userId,
          eventType: 'ERROR',
          status: 'FAILED',
          message: `Application preparation failed: ${code}`,
          metadata: { provider: failedProvider, code },
        },
      })
      .catch(() => undefined);
    if (run) {
      await completeAutomationRun(run.id, { status: 'FAILED', errorMessage: message }).catch(
        () => undefined
      );
    }
    throw err;
  } finally {
    if (browserContext && ownedContext) {
      await browserContext.close().catch(() => undefined);
    }
  }
}
