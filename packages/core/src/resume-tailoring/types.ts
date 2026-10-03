/**
 * Phase 11 - Resume Tailoring and Resume Versioning: shared types.
 *
 * Provider-independent and deterministic by design. The tailoring pipeline is:
 *
 *   source ResumeVersion + candidate facts + Job
 *       -> scoped context -> grounded AI generation (structured contract)
 *       -> deterministic anti-fabrication validation
 *       -> NEW immutable ResumeVersion (source = TAILORED)
 *
 * Nothing in this module fills an ATS form, submits an application, builds a
 * review UI, or modifies a source ResumeVersion. The result is a tailored
 * version that is READY FOR HUMAN REVIEW.
 */
import type { AiProvider } from '@jaa/ai';

/**
 * Versioned tailoring strategy. It is part of the idempotency identity
 * (user + job + source version + strategy): re-running the same identity
 * reuses the previously produced valid version unless a new run is requested.
 */
export const TAILORING_STRATEGY = 'JOB_ALIGNED_V1';

/** How the generated version's content is stored (no PDF/DOCX rendering here). */
export type TailoredContentFormat = 'STRUCTURED_JSON';

// ============================================================================
// Structured tailoring output contract
// ============================================================================

/**
 * The structured content the model must return. Every claim must be traceable
 * to candidate facts; the validator enforces that deterministically. Dates are
 * NOT part of this contract - they are always taken from the source facts and
 * can never be altered by the model.
 */
export interface TailoredExperienceEntry {
  /** Optional reference to a stored Experience record (validated when present). */
  experienceId?: string;
  company: string;
  title: string;
  bullets: string[];
}

export interface TailoredEducationEntry {
  /** Optional reference to a stored Education record (validated when present). */
  educationId?: string;
  institution: string;
  degree: string;
  fieldOfStudy: string;
  details?: string[];
}

export interface TailoredResumeContent {
  summary?: string;
  skills?: string[];
  experience?: TailoredExperienceEntry[];
  education?: TailoredEducationEntry[];
}

/** Allowed top-level keys of the structured output contract. */
export const TAILORED_CONTENT_KEYS = ['summary', 'skills', 'experience', 'education'] as const;
export const TAILORED_EXPERIENCE_KEYS = ['experienceId', 'company', 'title', 'bullets'] as const;
export const TAILORED_EDUCATION_KEYS = [
  'educationId',
  'institution',
  'degree',
  'fieldOfStudy',
  'details',
] as const;

// ============================================================================
// Validation
// ============================================================================

export type TailoringViolationType =
  | 'UNSUPPORTED_EMPLOYER'
  | 'UNSUPPORTED_TITLE'
  | 'UNSUPPORTED_SKILL'
  | 'UNSUPPORTED_INSTITUTION'
  | 'UNSUPPORTED_DEGREE'
  | 'UNSUPPORTED_CERTIFICATION'
  | 'UNSUPPORTED_METRIC'
  | 'UNSUPPORTED_DATE'
  | 'UNSUPPORTED_FIELD'
  | 'EMPTY_OUTPUT';

/**
 * A structured anti-fabrication violation. `value` is the offending generated
 * token (AI output, never candidate data) so failures are auditable.
 */
export interface TailoringViolation {
  type: TailoringViolationType;
  value: string;
  /** Where the violation was found (JSON path-ish, e.g. "experience[0].company"). */
  path?: string;
}

export interface TailoringValidationResult {
  valid: boolean;
  violations: TailoringViolation[];
}

// ============================================================================
// Structured fact sources (structural subsets of the Prisma records so both
// real DB rows and test literals satisfy them).
// ============================================================================

export interface TailorProfileFacts {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
  email: string;
  phone?: string | null;
  location?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  portfolioUrl?: string | null;
  websiteUrl?: string | null;
  workAuthorization?: string | null;
  desiredRoles?: string[];
  summary?: string | null;
}

export interface TailorExperienceFacts {
  /** Stored Experience row id (absent for entries parsed from a resume). */
  id?: string;
  title: string;
  company: string;
  location?: string | null;
  employmentType?: string | null;
  startDate: Date | string;
  endDate?: Date | string | null;
  isCurrent?: boolean;
  description?: string | null;
}

export interface TailorEducationFacts {
  /** Stored Education row id (absent for entries parsed from a resume). */
  id?: string;
  institution: string;
  degree: string;
  fieldOfStudy?: string | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  gpa?: number | null;
  description?: string | null;
}

export interface TailorSkillFacts {
  name: string;
  category?: string | null;
  proficiency?: string | null;
  yearsOfExperience?: number | null;
}

/** The source resume content being tailored (from ResumeVersion). */
export interface SourceResumeContent {
  extractedText?: string | null;
  parsedData?: Record<string, unknown> | null;
}

/**
 * Scoped tailoring context. Contains only resume-relevant candidate data
 * (identity, contact, location, links, summary, desired roles, work
 * authorization when meaningful, experience, education, skills, source
 * resume content) - never salary expectations or unrelated user data.
 */
export interface TailoringContext {
  profile: TailorProfileFacts | null;
  experience: TailorExperienceFacts[];
  education: TailorEducationFacts[];
  skills: TailorSkillFacts[];
  source: SourceResumeContent;
  /** Derived total years of experience (merged intervals), when computable. */
  yearsOfExperience: number | null;
  /**
   * Full lowercased text corpus of everything the generated content may
   * reference (fact labels + source resume content + derived values). The
   * validator checks every generated skill/metric/date/certification against
   * this corpus.
   */
  corpus: string;
}

/** Job context used ONLY to decide what to emphasize (never to add facts). */
export interface TailorJobContext {
  id?: string;
  company: string;
  title: string;
  location?: string | null;
  description?: string | null;
  employmentType?: string | null;
  workMode?: string | null;
  requirements?: string[] | null;
  responsibilities?: string[] | null;
  skills?: string[] | null;
}

// ============================================================================
// Provenance
// ============================================================================

/**
 * Tailoring provenance, persisted as the ResumeVersion `tailoring` JSON. It
 * records source version, target job, strategy, AI provenance and validation
 * status - never resume text, prompts, AI output, or personal data.
 */
export interface TailoringProvenance {
  sourceVersionId: string;
  jobId: string;
  strategy: string;
  aiGenerated: true;
  provider: string;
  model?: string;
  validationStatus: 'PASSED';
  contentFormat: TailoredContentFormat;
  promptVersion: string;
  generatedAt: string;
}

// ============================================================================
// Orchestration API
// ============================================================================

export type ResumeTailoringErrorCode =
  | 'RESUME_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'JOB_NOT_FOUND'
  | 'EMPTY_RESUME_CONTENT'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_EMPTY_RESPONSE'
  | 'AI_INVALID_RESPONSE'
  | 'AI_REQUEST_FAILED'
  | 'MODEL_REQUESTED_REVIEW'
  | 'VALIDATION_FAILED';

/**
 * Structured tailoring failure. Carries a stable code and, for validation
 * failures, the structured violations. Never contains resume text or prompts.
 */
export class ResumeTailoringError extends Error {
  readonly code: ResumeTailoringErrorCode;
  readonly violations: TailoringViolation[];

  constructor(
    code: ResumeTailoringErrorCode,
    message: string,
    options?: { violations?: TailoringViolation[] }
  ) {
    super(message);
    this.name = 'ResumeTailoringError';
    this.code = code;
    this.violations = options?.violations ?? [];
  }
}

export interface TailorResumeParams {
  /** The resume the source version belongs to. */
  resumeId: string;
  /** The source ResumeVersion to tailor (never mutated). */
  versionId: string;
  /** The target Job (must belong to the same user). */
  jobId: string;
  /** When provided, ownership is enforced (mismatch -> *_NOT_FOUND). */
  userId?: string;
  /**
   * Deliberately produce a new tailored version even when an identical
   * tailoring request already produced a valid one.
   */
  regenerate?: boolean;
  /**
   * Injected AI provider (mocked in tests). `undefined` resolves the
   * configured default provider; explicit `null` means no provider is
   * available (a structured AI failure follows - never fabricated content).
   */
  aiProvider?: AiProvider | null;
  /**
   * Stores the tailored artifact and returns its location for the new
   * version's `filePath`. Defaults to the existing local-file storage
   * convention (uploads/resumes).
   */
  storeArtifact?: TailorArtifactStore;
}

export interface TailorArtifactStore {
  (artifact: {
    userId: string;
    resumeId: string;
    versionNumber: number;
    content: TailoredResumeContent;
    text: string;
  }): Promise<string>;
}

export interface TailorResumeResult {
  /** True when a previous valid tailored version was reused (idempotency). */
  reused: boolean;
  /** The tailored ResumeVersion (new, immutable, source = TAILORED). */
  version: {
    id: string;
    resumeId: string;
    versionNumber: number;
    filePath: string;
    source: string;
    changeSummary: string | null;
  };
  content: TailoredResumeContent;
  validation: TailoringValidationResult;
  provenance: TailoringProvenance;
}
