/**
 * Phase 12 - human review workflow: view, approve, reject.
 *
 * Guarantees:
 *  - only eligible versions enter the workspace: source TAILORED/USER_EDITED
 *    with tailoring provenance whose validationStatus is 'PASSED' and whose
 *    source version still exists (the Phase 11 validation status is reused -
 *    there is no second validation system);
 *  - ownership is enforced when `userId` is supplied (mismatch -> *_NOT_FOUND,
 *    indistinguishable from non-existence);
 *  - approve/reject are atomic state transitions on the version's review
 *    state; repeated identical decisions are idempotent and conflicting
 *    decisions are rejected with REVIEW_CONFLICT;
 *  - the version content (and every other ResumeVersion) is NEVER modified -
 *    only reviewStatus/reviewedAt/reviewedBy/reviewNotes change;
 *  - Application.status is NEVER touched. Resume approval is not application
 *    approval;
 *  - audit events carry ids/statuses only - never resume text, candidate
 *    facts, prompts, notes, or personal data.
 */
import { prisma } from '@jaa/database';
import type { Prisma } from '@prisma/client';
import type {
  ReviewChangedSection,
  ReviewEducationEntry,
  ReviewExperienceEntry,
  ReviewResumeContent,
  ResumeReviewProvenance,
  ResumeReviewState,
  ResumeReviewView,
  ResumeReviewStatus,
} from '@jaa/shared';

import type { ReviewDecision, ReviewTargetParams } from './types';
import { ResumeReviewError } from './types';

// ============================================================================
// Pure helpers (unit-testable without a database)
// ============================================================================

/** Extract the stored tailoring provenance object, if any. */
export function provenanceOf(tailoring: unknown): Record<string, unknown> | null {
  if (tailoring && typeof tailoring === 'object' && !Array.isArray(tailoring)) {
    return tailoring as Record<string, unknown>;
  }
  return null;
}

const REVIEWABLE_SOURCES = new Set(['TAILORED', 'USER_EDITED']);

/**
 * Provenance is reviewable when it is complete and its Phase 11 validation
 * status is 'PASSED'. Failed or invalid tailoring can never be approved.
 */
export function isReviewableProvenance(prov: Record<string, unknown> | null): boolean {
  return (
    prov !== null &&
    prov['validationStatus'] === 'PASSED' &&
    typeof prov['sourceVersionId'] === 'string' &&
    prov['sourceVersionId'] !== '' &&
    typeof prov['jobId'] === 'string' &&
    prov['jobId'] !== '' &&
    typeof prov['strategy'] === 'string' &&
    prov['strategy'] !== ''
  );
}

/**
 * A version is reviewable when it is a tailored (or human-edited) version with
 * reviewable provenance. ORIGINAL/IMPORTED versions can never be approved as
 * tailored.
 */
export function isReviewableVersion(version: {
  source?: string | null;
  tailoring?: unknown;
}): boolean {
  if (!version.source || !REVIEWABLE_SOURCES.has(version.source)) return false;
  return isReviewableProvenance(provenanceOf(version.tailoring));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function splitLines(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split('\n')
        .map((l) => l.replace(/^-[\s*]+/, '').trim())
        .filter((l) => l !== '')
    : [];
}

function asDateLabel(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 7);
  return null;
}

/**
 * Normalize stored parsedData (ParsedProfile-compatible) into the
 * section-level shape the review UI compares. Bullets come from the structured
 * `bullets` array when present, otherwise from the description lines.
 */
export function buildReviewSections(parsedData: unknown): ReviewResumeContent {
  const data =
    parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)
      ? (parsedData as Record<string, unknown>)
      : {};

  const experience: ReviewExperienceEntry[] = Array.isArray(data['experience'])
    ? (data['experience'] as unknown[])
        .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
        .map((e) => ({
          company: typeof e['company'] === 'string' ? e['company'] : '',
          title: typeof e['title'] === 'string' ? e['title'] : '',
          startDate: asDateLabel(e['startDate']),
          endDate: e['isCurrent'] === true ? null : asDateLabel(e['endDate']),
          isCurrent: e['isCurrent'] === true,
          bullets: Array.isArray(e['bullets']) ? stringArray(e['bullets']) : splitLines(e['description']),
        }))
    : [];

  const education: ReviewEducationEntry[] = Array.isArray(data['education'])
    ? (data['education'] as unknown[])
        .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
        .map((e) => ({
          institution: typeof e['institution'] === 'string' ? e['institution'] : '',
          degree: typeof e['degree'] === 'string' ? e['degree'] : '',
          fieldOfStudy: typeof e['fieldOfStudy'] === 'string' ? e['fieldOfStudy'] : '',
          details: Array.isArray(e['details']) ? stringArray(e['details']) : splitLines(e['description']),
        }))
    : [];

  return {
    summary: typeof data['summary'] === 'string' ? data['summary'] : null,
    skills: stringArray(data['skills']),
    experience,
    education,
  };
}

/** Sections whose content differs between the source and tailored version. */
export function changedSectionsOf(
  source: ReviewResumeContent,
  tailored: ReviewResumeContent
): ReviewChangedSection[] {
  const changed: ReviewChangedSection[] = [];
  for (const key of ['summary', 'skills', 'experience', 'education'] as const) {
    if (JSON.stringify(source[key]) !== JSON.stringify(tailored[key])) changed.push(key);
  }
  return changed;
}

/**
 * Safe provenance for the UI: whitelisted fields only. Even if the stored
 * JSON ever contained extra keys (prompts, secrets), they are dropped here.
 */
export function safeProvenanceOf(tailoring: unknown): ResumeReviewProvenance | null {
  const prov = provenanceOf(tailoring);
  if (!prov) return null;
  return {
    sourceVersionId: String(prov['sourceVersionId'] ?? ''),
    jobId: String(prov['jobId'] ?? ''),
    strategy: String(prov['strategy'] ?? ''),
    aiGenerated: prov['aiGenerated'] === true,
    ...(typeof prov['provider'] === 'string' ? { provider: prov['provider'] } : {}),
    ...(typeof prov['model'] === 'string' ? { model: prov['model'] } : {}),
    validationStatus: String(prov['validationStatus'] ?? ''),
    contentFormat: String(prov['contentFormat'] ?? ''),
    ...(typeof prov['promptVersion'] === 'string' ? { promptVersion: prov['promptVersion'] } : {}),
    generatedAt: String(prov['generatedAt'] ?? ''),
    ...(prov['aiGenerated'] === false ? { humanEdited: true } : {}),
  };
}

interface ReviewableRecord {
  id: string;
  reviewStatus?: ResumeReviewStatus | string | null;
  reviewedAt?: Date | string | null;
  reviewedBy?: string | null;
  reviewNotes?: string | null;
}

export function reviewStateOf(version: ReviewableRecord): ResumeReviewState {
  return {
    reviewStatus: (version.reviewStatus ?? 'PENDING') as ResumeReviewStatus,
    reviewedAt: version.reviewedAt
      ? new Date(version.reviewedAt).toISOString()
      : null,
    reviewedBy: version.reviewedBy ?? null,
    reviewNotes: version.reviewNotes ?? null,
  };
}

// ============================================================================
// Database workflow
// ============================================================================

interface ReviewTarget {
  resume: { id: string; userId: string; name: string };
  version: {
    id: string;
    resumeId: string;
    versionNumber: number;
    source: string;
    changeSummary: string | null;
    extractedText: string | null;
    parsedData: unknown;
    tailoring: unknown;
    createdAt: Date;
    reviewStatus: ResumeReviewStatus;
    reviewedAt: Date | null;
    reviewedBy: string | null;
    reviewNotes: string | null;
  };
  provenance: Record<string, unknown>;
  sourceVersion: {
    id: string;
    versionNumber: number;
    source: string;
    extractedText: string | null;
    parsedData: unknown;
    createdAt: Date;
  };
  job: {
    id: string;
    company: string;
    title: string;
    location: string | null;
    employmentType: string | null;
    workMode: string | null;
  } | null;
}

/**
 * Load and authorize the review target. Ownership failures and non-existence
 * are indistinguishable (both *_NOT_FOUND); a version without valid tailoring
 * provenance (or whose source version is gone) is NOT_REVIEWABLE.
 */
export async function loadReviewTarget(params: ReviewTargetParams): Promise<ReviewTarget> {
  const resume = await prisma.resume.findUnique({ where: { id: params.resumeId } });
  if (!resume || (params.userId && resume.userId !== params.userId)) {
    throw new ResumeReviewError('RESUME_NOT_FOUND', 'Resume not found');
  }

  const version = await prisma.resumeVersion.findFirst({
    where: { id: params.versionId, resumeId: params.resumeId },
  });
  if (!version) {
    throw new ResumeReviewError('VERSION_NOT_FOUND', 'Resume version not found');
  }

  if (!isReviewableVersion(version)) {
    throw new ResumeReviewError(
      'NOT_REVIEWABLE',
      'Only validated tailored resume versions can be reviewed'
    );
  }
  const provenance = provenanceOf(version.tailoring)!;

  const sourceVersion = await prisma.resumeVersion.findFirst({
    where: { id: provenance['sourceVersionId'] as string, resumeId: params.resumeId },
  });
  if (!sourceVersion) {
    throw new ResumeReviewError('NOT_REVIEWABLE', 'The source resume version is missing');
  }

  // Job context is display-only; a job the user does not own is never shown.
  let job: ReviewTarget['job'] = null;
  const jobRow = await prisma.job.findUnique({ where: { id: provenance['jobId'] as string } });
  if (jobRow && jobRow.userId === resume.userId) {
    job = {
      id: jobRow.id,
      company: jobRow.company,
      title: jobRow.title,
      location: jobRow.location,
      employmentType: jobRow.employmentType,
      workMode: jobRow.workMode,
    };
  }

  return {
    resume: { id: resume.id, userId: resume.userId, name: resume.name },
    version: {
      id: version.id,
      resumeId: version.resumeId,
      versionNumber: version.versionNumber,
      source: version.source,
      changeSummary: version.changeSummary,
      extractedText: version.extractedText,
      parsedData: version.parsedData,
      tailoring: version.tailoring,
      createdAt: version.createdAt,
      reviewStatus: version.reviewStatus,
      reviewedAt: version.reviewedAt,
      reviewedBy: version.reviewedBy,
      reviewNotes: version.reviewNotes,
    },
    provenance,
    sourceVersion: {
      id: sourceVersion.id,
      versionNumber: sourceVersion.versionNumber,
      source: sourceVersion.source,
      extractedText: sourceVersion.extractedText,
      parsedData: sourceVersion.parsedData,
      createdAt: sourceVersion.createdAt,
    },
    job,
  };
}

/**
 * Everything the review workspace needs to render: source version, tailored
 * version, job info, safe tailoring metadata, validation status, review
 * status, and version information. No prompts, secrets, storage paths, or
 * raw audit metadata are ever included.
 */
export async function loadReviewView(params: ReviewTargetParams): Promise<ResumeReviewView> {
  const target = await loadReviewTarget(params);
  const sourceContent = buildReviewSections(target.sourceVersion.parsedData);
  const tailoredContent = buildReviewSections(target.version.parsedData);

  return {
    resume: { id: target.resume.id, name: target.resume.name },
    version: {
      id: target.version.id,
      resumeId: target.version.resumeId,
      versionNumber: target.version.versionNumber,
      source: target.version.source,
      changeSummary: target.version.changeSummary,
      createdAt: target.version.createdAt.toISOString(),
    },
    review: reviewStateOf(target.version),
    sourceVersion: {
      id: target.sourceVersion.id,
      versionNumber: target.sourceVersion.versionNumber,
      source: target.sourceVersion.source,
      createdAt: target.sourceVersion.createdAt.toISOString(),
    },
    sourceContent,
    tailoredContent,
    sourceText: target.sourceVersion.extractedText,
    tailoredText: target.version.extractedText,
    job: target.job,
    provenance: safeProvenanceOf(target.provenance)!,
    validationStatus: String(target.provenance['validationStatus'] ?? ''),
    changedSections: changedSectionsOf(sourceContent, tailoredContent),
  };
}

/**
 * Application-scoped audit trail (same convention as Phase 11): recorded on
 * the user's Application for the target job when one exists. Metadata is
 * ids/statuses only - never resume text, notes, or personal data.
 */
async function reviewAuditEvent(params: {
  userId: string;
  jobId: string;
  eventType: 'RESUME_APPROVED' | 'RESUME_REJECTED';
  reviewStatus: 'APPROVED' | 'REJECTED';
  resumeId: string;
  versionId: string;
  sourceVersionId: string;
  strategy: string;
}): Promise<void> {
  const application = await prisma.application.findFirst({
    where: { userId: params.userId, jobId: params.jobId },
    select: { id: true, status: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!application) return;
  await prisma.applicationEvent.create({
    data: {
      applicationId: application.id,
      userId: params.userId,
      eventType: params.eventType,
      status: application.status,
      message:
        params.reviewStatus === 'APPROVED'
          ? 'Tailored resume approved by human review'
          : 'Tailored resume rejected in human review',
      metadata: {
        resumeId: params.resumeId,
        versionId: params.versionId,
        sourceVersionId: params.sourceVersionId,
        jobId: params.jobId,
        reviewStatus: params.reviewStatus,
        strategy: params.strategy,
      } as Prisma.InputJsonValue,
    },
  });
}

/**
 * Apply a review decision with an atomic PENDING -> target transition.
 *
 * - repeat of the current state -> idempotent success (changed: false);
 * - conflicting decision (approve after reject or vice versa) ->
 *   REVIEW_CONFLICT, state untouched;
 * - concurrent requests: the conditional update guarantees a single winner;
 *   the loser re-reads and honors the same state machine.
 */
async function applyDecision(
  params: ReviewTargetParams,
  nextState: 'APPROVED' | 'REJECTED',
  note?: string | null
): Promise<ReviewDecision> {
  const target = await loadReviewTarget(params);
  const reviewer = params.userId ?? target.resume.userId;

  const current = target.version.reviewStatus ?? 'PENDING';
  if (current === nextState) {
    return { review: reviewStateOf(target.version), changed: false };
  }
  if (current !== 'PENDING') {
    throw new ResumeReviewError(
      'REVIEW_CONFLICT',
      `Resume version is already ${current.toLowerCase()}`
    );
  }

  const now = new Date();
  const updated = await prisma.resumeVersion.updateMany({
    where: { id: target.version.id, reviewStatus: 'PENDING' },
    data: {
      reviewStatus: nextState,
      reviewedAt: now,
      reviewedBy: reviewer,
      ...(nextState === 'REJECTED' ? { reviewNotes: note ?? null } : {}),
    },
  });

  if (updated.count === 0) {
    const fresh = await prisma.resumeVersion.findUnique({
      where: { id: target.version.id },
    });
    if (!fresh) {
      throw new ResumeReviewError('VERSION_NOT_FOUND', 'Resume version not found');
    }
    const state = fresh.reviewStatus ?? 'PENDING';
    if (state === nextState) {
      return { review: reviewStateOf(fresh), changed: false };
    }
    throw new ResumeReviewError(
      'REVIEW_CONFLICT',
      `Resume version is already ${state.toLowerCase()}`
    );
  }

  await reviewAuditEvent({
    userId: target.resume.userId,
    jobId: target.provenance['jobId'] as string,
    eventType: nextState === 'APPROVED' ? 'RESUME_APPROVED' : 'RESUME_REJECTED',
    reviewStatus: nextState,
    resumeId: target.resume.id,
    versionId: target.version.id,
    sourceVersionId: target.provenance['sourceVersionId'] as string,
    strategy: String(target.provenance['strategy'] ?? ''),
  });

  return {
    review: {
      reviewStatus: nextState,
      reviewedAt: now.toISOString(),
      reviewedBy: reviewer,
      reviewNotes: nextState === 'REJECTED' ? (note ?? null) : (target.version.reviewNotes ?? null),
    },
    changed: true,
  };
}

/**
 * Approve a tailored resume version (resume approval only - Application
 * status is never changed and nothing is submitted). Idempotent: approving an
 * already-approved version is a no-op success.
 */
export async function approveResumeVersion(params: ReviewTargetParams): Promise<ReviewDecision> {
  return applyDecision(params, 'APPROVED');
}

/**
 * Reject a tailored resume version with an optional short note. The version
 * is kept (never deleted), never mutated beyond its review state, and nothing
 * is regenerated or re-run. Idempotent: rejecting an already-rejected version
 * is a no-op success (the original note and timestamp are preserved).
 */
export async function rejectResumeVersion(
  params: ReviewTargetParams & { note?: string | null }
): Promise<ReviewDecision> {
  return applyDecision(params, 'REJECTED', params.note ?? null);
}
