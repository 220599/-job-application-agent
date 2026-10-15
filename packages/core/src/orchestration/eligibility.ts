import { prisma } from '@jaa/database';
import type { Application, ResumeVersion } from '@jaa/database';
import type { AtsAdapter, AtsRegistry } from '@jaa/ats';

import { provenanceOf } from '../resume-review';
import { findUnresolvedSubmissionAttempt } from '../application-submission';
import {
  OrchestrationError,
  PREPARABLE_APPLICATION_STATUSES,
  TERMINAL_APPLICATION_STATUSES,
} from './types';
import { createPreparationRegistry } from './registry';

/**
 * Phase 13 - server-side application preparation eligibility.
 *
 * All checks happen here, never in the frontend. An application may be queued
 * for preparation only when every requirement below holds:
 *
 *   1. the application exists and belongs to the authenticated user;
 *   2. it has a resume version;
 *   3. that version is APPROVED (human review, Phase 12);
 *   4. its tailoring validation passed when tailoring provenance is present;
 *   5. it is not in a terminal status (and is otherwise preparable);
 *   6. it has an application URL that parses as http(s);
 *   7. a registered ATS adapter supports that URL.
 */

export interface EligibilityParams {
  applicationId: string;
  userId: string;
  registry?: AtsRegistry;
}

export interface EligibilityResult {
  application: Application & { resumeVersion: ResumeVersion };
  adapter: AtsAdapter;
  provider: string;
  applicationUrl: string;
}

export async function checkPreparationEligibility(
  params: EligibilityParams
): Promise<EligibilityResult> {
  const application = await prisma.application.findUnique({
    where: { id: params.applicationId },
    include: { resumeVersion: true },
  });

  // Missing and foreign applications are indistinguishable on purpose - the
  // API must never leak whether another user's application exists.
  if (!application || application.userId !== params.userId) {
    throw new OrchestrationError('APPLICATION_NOT_FOUND', 'Application not found');
  }

  if (TERMINAL_APPLICATION_STATUSES.includes(application.status)) {
    throw new OrchestrationError(
      'APPLICATION_TERMINAL',
      `Application is in terminal status ${application.status} and cannot be prepared`
    );
  }
  if (!PREPARABLE_APPLICATION_STATUSES.includes(application.status)) {
    throw new OrchestrationError(
      'APPLICATION_STATE_NOT_PREPARABLE',
      `Application status ${application.status} cannot be queued for preparation`
    );
  }

  // Phase 15D lifecycle guard: an application with an UNRESOLVED submission
  // attempt has an UNKNOWN submission outcome (a previous worker may have
  // submitted without recording it). It requires human resolution and must
  // NEVER be reset to a fresh preparation state (which would erase the
  // "requires resolution" signal and could lead to a second submission).
  const unresolvedAttemptId = await findUnresolvedSubmissionAttempt(application.id);
  if (unresolvedAttemptId) {
    throw new OrchestrationError(
      'SUBMISSION_OUTCOME_UNKNOWN',
      'A previous submission attempt has an unknown outcome; the application requires human resolution and cannot be prepared again'
    );
  }

  const version = application.resumeVersion;
  if (!version) {
    throw new OrchestrationError(
      'RESUME_NOT_APPROVED',
      'Application has no resume version'
    );
  }
  if (version.reviewStatus !== 'APPROVED') {
    throw new OrchestrationError(
      'RESUME_NOT_APPROVED',
      'The resume version must be approved before preparation can be queued'
    );
  }

  // Tailoring validation (Phase 11 anti-fabrication) must have passed when
  // tailoring provenance is present on the approved version.
  const provenance = provenanceOf(version.tailoring);
  if (provenance && provenance['validationStatus'] !== 'PASSED') {
    throw new OrchestrationError(
      'TAILORING_NOT_VALIDATED',
      'The resume version did not pass tailoring validation'
    );
  }

  const rawUrl = application.applicationUrl;
  if (!rawUrl) {
    throw new OrchestrationError(
      'APPLICATION_URL_MISSING',
      'Application has no application URL'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new OrchestrationError(
      'INVALID_APPLICATION_URL',
      'Application URL is not a valid URL'
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OrchestrationError(
      'INVALID_APPLICATION_URL',
      'Application URL must use http or https'
    );
  }

  const registry = params.registry ?? createPreparationRegistry();
  const adapter = registry.findForUrl(rawUrl);
  if (!adapter) {
    throw new OrchestrationError(
      'UNSUPPORTED_ATS',
      'No supported ATS provider can handle this application URL'
    );
  }

  return {
    application,
    adapter,
    provider: adapter.provider,
    applicationUrl: rawUrl,
  };
}
