/**
 * Phase 12 - Human Review Workspace: shared types.
 *
 * The review workspace is the safety boundary between AI-generated resume
 * tailoring (Phase 11) and any later automation: a tailored ResumeVersion can
 * only proceed after a human APPROVES it. This module approves or rejects
 * resume versions - it never touches Application.status, never submits
 * anything, and never calls AI or ATS providers.
 *
 * Review lifecycle (per ResumeVersion, never mutating the version's content):
 *
 *   PENDING --approve--> APPROVED
 *   PENDING --reject---> REJECTED
 *
 * Human corrections create another immutable ResumeVersion (source =
 * USER_EDITED) instead of mutating an existing one; the Phase 11
 * anti-fabrication validator remains the authority over edited content.
 */
import type {
  ReviewChangedSection,
  ReviewResumeContent,
  ResumeReviewProvenance,
  ResumeReviewState,
  ResumeReviewView,
  ResumeReviewStatus,
} from '@jaa/shared';
import type { TailoredResumeContent, TailorArtifactStore } from '../resume-tailoring';
import type { TailoringViolation } from '../resume-tailoring';

export type {
  ReviewChangedSection,
  ReviewResumeContent,
  ResumeReviewProvenance,
  ResumeReviewState,
  ResumeReviewView,
  ResumeReviewStatus,
};

/**
 * Versioned human-edit strategy, stored in the version's `tailoring` JSON so
 * edited versions remain distinguishable from AI-tailored ones (and are never
 * confused with the Phase 11 tailoring idempotency identity).
 */
export const HUMAN_EDIT_STRATEGY = 'HUMAN_EDIT_V1';

/**
 * Provenance persisted for human-edited versions (same `tailoring` column as
 * Phase 11). Records lineage and validation status - never resume text,
 * prompts, or personal data. `editedBy` is the acting user id only.
 */
export interface HumanEditProvenance {
  sourceVersionId: string;
  jobId: string;
  strategy: typeof HUMAN_EDIT_STRATEGY;
  aiGenerated: false;
  editedBy: string;
  validationStatus: 'PASSED';
  contentFormat: 'STRUCTURED_JSON';
  generatedAt: string;
}

export type ResumeReviewErrorCode =
  | 'RESUME_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'NOT_REVIEWABLE'
  | 'REVIEW_CONFLICT'
  | 'VALIDATION_FAILED';

/**
 * Structured review failure. Carries a stable code and, for anti-fabrication
 * failures, the structured violations. Never contains resume text or prompts.
 */
export class ResumeReviewError extends Error {
  readonly code: ResumeReviewErrorCode;
  readonly violations: TailoringViolation[];

  constructor(
    code: ResumeReviewErrorCode,
    message: string,
    options?: { violations?: TailoringViolation[] }
  ) {
    super(message);
    this.name = 'ResumeReviewError';
    this.code = code;
    this.violations = options?.violations ?? [];
  }
}

export interface ReviewTargetParams {
  /** The resume the reviewed version belongs to. */
  resumeId: string;
  /** The version to review (TAILORED or USER_EDITED with tailoring provenance). */
  versionId: string;
  /** When provided, ownership is enforced (mismatch -> *_NOT_FOUND). */
  userId?: string;
}

export interface ReviewDecision {
  review: ResumeReviewState;
  /** False when the request was an idempotent repeat of the current state. */
  changed: boolean;
}

export interface EditTailoredResumeParams extends ReviewTargetParams {
  /**
   * Human-corrected structured content. Always re-validated against the
   * candidate facts by the Phase 11 anti-fabrication validator - a human can
   * rephrase or remove claims but never introduce unsupported ones.
   */
  content: TailoredResumeContent;
  /** Stores the edited artifact (injectable for tests). */
  storeArtifact?: TailorArtifactStore;
}

export interface EditTailoredResumeResult {
  version: {
    id: string;
    resumeId: string;
    versionNumber: number;
    filePath: string;
    source: string;
    changeSummary: string | null;
  };
  content: TailoredResumeContent;
  provenance: HumanEditProvenance;
  review: ResumeReviewState;
}
