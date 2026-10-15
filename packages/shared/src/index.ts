// Core types used across the application

export interface ILogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
}

export interface ApplicationEvent {
  applicationId: string;
  eventType: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  userId: string;
  jobId: string;
  atsType: string;
}

export interface JobDescription {
  id: string;
  companyName: string;
  title: string;
  location: string;
  description: string;
  requirements: string[];
  responsibilities: string[];
  compensation?: {
    min?: number;
    max?: number;
    currency?: string;
  };
  atsType: string;
  atsJobId?: string;
  sourceUrl: string;
  extractedAt: Date;
}

export type WorkMode = 'REMOTE' | 'HYBRID' | 'ONSITE' | 'ANY';

export interface CandidateProfile {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  preferredName?: string;
  email: string;
  phone?: string;
  location?: string;
  city?: string;
  state?: string;
  country?: string;
  zipCode?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  websiteUrl?: string;
  workAuthorization: string;
  sponsorshipRequired: boolean;
  willingToRelocate: boolean;
  preferredWorkMode: WorkMode;
  preferredLocations: string[];
  desiredRoles: string[];
  desiredSalaryMin?: number;
  desiredSalaryMax?: number;
  summary?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CandidateProfileCreate {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  location?: string;
  city?: string;
  state?: string;
  country?: string;
  zipCode?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  websiteUrl?: string;
  workAuthorization?: string;
  sponsorshipRequired?: boolean;
  willingToRelocate?: boolean;
  preferredWorkMode?: WorkMode;
  preferredLocations?: string[];
  desiredRoles?: string[];
  desiredSalaryMin?: number;
  desiredSalaryMax?: number;
  summary?: string;
}

export interface CandidateProfileUpdate {
  firstName?: string;
  lastName?: string;
  preferredName?: string;
  email?: string;
  phone?: string;
  location?: string;
  city?: string;
  state?: string;
  country?: string;
  zipCode?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  websiteUrl?: string;
  workAuthorization?: string;
  sponsorshipRequired?: boolean;
  willingToRelocate?: boolean;
  preferredWorkMode?: WorkMode;
  preferredLocations?: string[];
  desiredRoles?: string[];
  desiredSalaryMin?: number;
  desiredSalaryMax?: number;
  summary?: string;
}

export interface Education {
  id: string;
  candidateProfileId: string;
  institution: string;
  degree: string;
  fieldOfStudy: string;
  startDate: Date;
  endDate?: Date;
  gpa?: number;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EducationCreate {
  institution: string;
  degree: string;
  fieldOfStudy: string;
  startDate: Date;
  endDate?: Date;
  gpa?: number;
  description?: string;
}

export interface EducationUpdate {
  institution?: string;
  degree?: string;
  fieldOfStudy?: string;
  startDate?: Date;
  endDate?: Date;
  gpa?: number;
  description?: string;
}

export interface Experience {
  id: string;
  candidateProfileId: string;
  company: string;
  title: string;
  location?: string;
  employmentType: string;
  startDate: Date;
  endDate?: Date;
  isCurrent: boolean;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExperienceCreate {
  company: string;
  title: string;
  location?: string;
  employmentType?: string;
  startDate: Date;
  endDate?: Date;
  isCurrent?: boolean;
  description?: string;
}

export interface ExperienceUpdate {
  company?: string;
  title?: string;
  location?: string;
  employmentType?: string;
  startDate?: Date;
  endDate?: Date;
  isCurrent?: boolean;
  description?: string;
}

export interface Skill {
  id: string;
  candidateProfileId: string;
  name: string;
  category?: string;
  proficiency: string;
  yearsOfExperience?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillCreate {
  name: string;
  category?: string;
  proficiency?: string;
  yearsOfExperience?: number;
}

export interface Resume {
  id: string;
  userId: string;
  name: string;
  originalFileName: string;
  fileType: string;
  storageKey: string;
  fileSize: number;
  mimeType: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  versions?: ResumeVersion[];
}

export type ResumeReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ResumeVersion {
  id: string;
  resumeId: string;
  versionNumber: number;
  filePath: string;
  source: string;
  changeSummary?: string;
  extractedText?: string;
  parsedData?: Record<string, unknown>;
  tailoring?: Record<string, unknown> | null;
  reviewStatus?: ResumeReviewStatus;
  reviewedAt?: Date | string | null;
  reviewedBy?: string | null;
  reviewNotes?: string | null;
  createdAt: Date;
}

// ============================================================================
// Human review workspace (Phase 12)
// ============================================================================

/** Section-normalized resume content used for source vs tailored comparison. */
export interface ReviewExperienceEntry {
  company: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  bullets: string[];
}

export interface ReviewEducationEntry {
  institution: string;
  degree: string;
  fieldOfStudy: string;
  details: string[];
}

export interface ReviewResumeContent {
  summary: string | null;
  skills: string[];
  experience: ReviewExperienceEntry[];
  education: ReviewEducationEntry[];
}

export type ReviewChangedSection = 'summary' | 'skills' | 'experience' | 'education';

/**
 * Safe tailoring provenance for the review UI. Whitelisted fields only -
 * never prompts, provider secrets, raw audit metadata, or resume content.
 */
export interface ResumeReviewProvenance {
  sourceVersionId: string;
  jobId: string;
  strategy: string;
  aiGenerated: boolean;
  provider?: string;
  model?: string;
  validationStatus: string;
  contentFormat: string;
  promptVersion?: string;
  generatedAt: string;
  humanEdited?: boolean;
}

export interface ResumeReviewState {
  reviewStatus: ResumeReviewStatus;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
}

/** Result of approve/reject: the new review state and whether it changed. */
export interface ResumeReviewDecision {
  review: ResumeReviewState;
  changed: boolean;
}

/** Result of a human edit: a NEW immutable USER_EDITED version (PENDING). */
export interface ResumeReviewEditResult {
  version: {
    id: string;
    resumeId: string;
    versionNumber: number;
    filePath: string;
    source: string;
    changeSummary: string | null;
  };
  review: ResumeReviewState;
  provenance: ResumeReviewProvenance;
}

export interface ResumeReviewView {
  resume: { id: string; name: string };
  version: {
    id: string;
    resumeId: string;
    versionNumber: number;
    source: string;
    changeSummary: string | null;
    createdAt: string;
  };
  review: ResumeReviewState;
  sourceVersion: { id: string; versionNumber: number; source: string; createdAt: string };
  sourceContent: ReviewResumeContent;
  tailoredContent: ReviewResumeContent;
  sourceText: string | null;
  tailoredText: string | null;
  job: {
    id: string;
    company: string;
    title: string;
    location: string | null;
    employmentType: string | null;
    workMode: string | null;
  } | null;
  provenance: ResumeReviewProvenance;
  validationStatus: string;
  changedSections: ReviewChangedSection[];
}

export interface MatchCriterion {
  criterion: string;
  status: 'MET' | 'PARTIAL' | 'UNMET' | 'NOT_APPLICABLE';
  detail: string;
}

/**
 * Deterministic match result stored in the JobMatch table.
 * Field names follow the API shape: `score` is the overall 0-100 match,
 * factor scores are null when that factor could not be evaluated.
 */
export interface JobMatchSummary {
  id: string;
  jobId: string;
  userId: string;
  score: number;
  skillsScore?: number | null;
  roleScore?: number | null;
  experienceScore?: number | null;
  locationScore?: number | null;
  salaryScore?: number | null;
  authorizationScore?: number | null;
  matchedSkills?: string[] | null;
  missingSkills?: string[] | null;
  matchedCriteria?: MatchCriterion[] | null;
  strengths?: string[] | null;
  gaps?: string[] | null;
  warnings?: string[] | null;
  explanation?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface Job {
  id: string;
  userId: string;
  externalId?: string;
  source: string;
  ats?: string;
  url: string;
  applicationUrl?: string;
  company: string;
  title: string;
  location?: string;
  description?: string;
  employmentType?: string;
  workMode?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency: string;
  requirements?: string[];
  responsibilities?: string[];
  skills?: string[];
  rawData?: Record<string, unknown>;
  postedAt?: Date;
  discoveredAt: Date;
  updatedAt: Date;
  createdAt: Date;
  /** Included by the jobs list/detail endpoints for the current user */
  jobMatches?: JobMatchSummary[];
  /**
   * Whether a registered ATS adapter can handle this job's application URL.
   * Computed by the jobs endpoints (single source of truth); the UI uses it to
   * enable or disable the Apply action instead of guessing board support.
   */
  applySupported?: boolean;
}

export interface MatchResult {
  score: number; // 0-100
  strengths: string[];
  gaps: string[];
  warnings: string[];
  requirements: {
    required: string[];
    missing: string[];
  };
}

export type ApplicationStatus =
  | 'DISCOVERED'
  | 'MATCHED'
  | 'PREPARING'
  | 'FORM_INSPECTED'
  | 'FORM_FILLED'
  | 'READY_FOR_REVIEW'
  | 'APPROVED'
  | 'SUBMITTED'
  | 'FAILED'
  | 'WITHDRAWN'
  | 'REJECTED'
  | 'INTERVIEW'
  | 'OFFER';

export interface ApplicationRecord {
  id: string;
  userId: string;
  jobId: string;
  candidateProfileId: string;
  resumeVersionId: string;
  atsType: string;
  status: ApplicationStatus;
  matchScore?: number;
  startedAt: Date;
  submittedAt?: Date;
  failedAt?: Date;
  withdrawnAt?: Date;
  rejectedAt?: Date;
  interviewOfferedAt?: Date;
  offerReceivedAt?: Date;
  confirmationData?: Record<string, unknown>;
  browserSessionMetadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AIResponse {
  answer: string;
  confidence: number; // 0-1
  groundedFacts: string[];
  needsReview: boolean;
  reasoning?: string;
}

export interface ErrorMetadata {
  errorCode: string;
  errorMessage: string;
  context: Record<string, unknown>;
  timestamp: Date;
  stackTrace?: string;
}

export type ErrorHandler = (error: Error, meta?: Record<string, unknown>) => void;

export interface QueueJob {
  id: string;
  type: string;
  data: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  processedAt?: Date;
  failedAt?: Date;
  error?: ErrorMetadata;
}

export const LOG_LEVELS = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const;

export type LogLevel = (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];

export interface Context {
  userId: string;
  applicationId?: string;
  jobId?: string;
  requestId: string;
  logger: ILogger;
}

// Export validation schemas
export * from './validation';

// Explicit re-exports for API route imports
export {
  candidateProfileCreateSchema,
  candidateProfileUpdateSchema,
  educationCreateSchema,
  educationUpdateSchema,
  experienceCreateSchema,
  experienceUpdateSchema,
  skillCreateSchema,
  skillUpdateSchema,
  resumeCreateSchema,
  resumeTailorSchema,
  resumeReviewRejectSchema,
  resumeReviewEditSchema,
  preparationJobPayloadSchema,
  jobCreateSchema,
  applicationCreateSchema,
  applicationStatusEnum,
  paginationSchema,
  apiResponseSchema,
  apiErrorSchema,
} from './validation';