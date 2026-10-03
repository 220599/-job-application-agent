/**
 * Phase 10 - AI Application Question Answering: shared types.
 *
 * Provider-independent and deterministic by design. The answer pipeline is:
 *
 *   question -> classify -> candidate facts -> deterministic answer
 *                                       \-> grounded AI generation
 *            -> confidence + provenance + needsReview -> ApplicationAnswer
 *
 * Nothing in this module submits an application, uploads a resume, tailors a
 * resume, builds a review UI, or auto-approves answers. The application
 * lifecycle stays pre-submission.
 */
import type { AiProvider } from '@jaa/ai';

/**
 * Deterministic question categories. Classification happens BEFORE any LLM is
 * invoked - the classifier is pure and provider independent.
 */
export type QuestionCategory =
  | 'FIRST_NAME'
  | 'LAST_NAME'
  | 'FULL_NAME'
  | 'PREFERRED_NAME'
  | 'EMAIL'
  | 'PHONE'
  | 'LOCATION'
  | 'LINKEDIN'
  | 'GITHUB'
  | 'PORTFOLIO'
  | 'WEBSITE'
  | 'WORK_AUTHORIZATION'
  | 'SPONSORSHIP'
  | 'EXPERIENCE'
  | 'EDUCATION'
  | 'SKILLS'
  | 'YEARS_OF_EXPERIENCE'
  | 'SALARY'
  | 'NOTICE_PERIOD'
  | 'START_DATE'
  | 'WORK_PREFERENCE'
  | 'COVER_LETTER'
  | 'MOTIVATION'
  | 'WHY_COMPANY'
  | 'WHY_ROLE'
  | 'EXPERIENCE_DESCRIPTION'
  | 'OTHER';

/**
 * Provenance recorded on ApplicationAnswer.source. Matches the values the
 * schema comment enumerates (PROFILE, RESUME, USER_INPUT, AI, SYSTEM) plus the
 * more specific fact origins the spec calls for (EXPERIENCE, EDUCATION, SKILL).
 * The DB column is a free string, so no migration is needed.
 */
export type AnswerSource =
  | 'PROFILE'
  | 'EXPERIENCE'
  | 'EDUCATION'
  | 'SKILL'
  | 'RESUME'
  | 'AI'
  | 'USER_INPUT'
  | 'SYSTEM';

/** How an answer is produced. */
export type AnswerStrategy = 'DETERMINISTIC' | 'AI' | 'MANUAL';

/**
 * A single grounded candidate fact. Facts are only created from data that
 * actually exists in the user's records - never inferred.
 */
export interface CandidateFact {
  /** Stable key, e.g. "email", "experience:0:title". */
  key: string;
  /** Human readable label used for provenance and prompts. */
  label: string;
  /** The fact value as text. */
  value: string;
  /** Where the fact came from. */
  source: AnswerSource;
}

// ============================================================================
// Structured fact sources (structural subsets of the Prisma records so both
// real DB rows and test literals satisfy them).
// ============================================================================

export interface ProfileFacts {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
  email: string;
  phone?: string | null;
  location?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  zipCode?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  portfolioUrl?: string | null;
  websiteUrl?: string | null;
  workAuthorization?: string | null;
  sponsorshipRequired?: boolean | null;
  willingToRelocate?: boolean | null;
  preferredWorkMode?: string | null;
  preferredLocations?: string[];
  desiredRoles?: string[];
  desiredSalaryMin?: number | null;
  desiredSalaryMax?: number | null;
  summary?: string | null;
}

export interface ExperienceFacts {
  title: string;
  company: string;
  location?: string | null;
  employmentType?: string | null;
  startDate: Date | string;
  endDate?: Date | string | null;
  isCurrent?: boolean;
  description?: string | null;
}

export interface EducationFacts {
  institution: string;
  degree: string;
  fieldOfStudy?: string | null;
  startDate: Date | string;
  endDate?: Date | string | null;
  gpa?: number | null;
  description?: string | null;
}

export interface SkillFacts {
  name: string;
  category?: string | null;
  proficiency?: string | null;
  yearsOfExperience?: number | null;
}

export interface ResumeFacts {
  extractedText?: string | null;
  parsedData?: Record<string, unknown> | null;
}

/** Controlled candidate fact context built from the user's stored records. */
export interface CandidateContext {
  profile: ProfileFacts | null;
  experience: ExperienceFacts[];
  education: EducationFacts[];
  skills: SkillFacts[];
  resume: ResumeFacts | null;
  /** All flattened facts (already scoped/derived). */
  facts: CandidateFact[];
}

/**
 * Job context used ONLY to tailor wording. The model must never invent
 * candidate experience to match a job requirement.
 */
export interface JobContext {
  company?: string | null;
  title?: string | null;
  location?: string | null;
  description?: string | null;
  requirements?: string[] | null;
  responsibilities?: string[] | null;
  skills?: string[] | null;
}

/** The shape of an ApplicationQuestion the pipeline needs (provider neutral). */
export interface QuestionInput {
  id: string;
  label: string;
  normalizedLabel?: string | null;
  fieldType?: string | null;
  required?: boolean;
  options?: { value: string; label: string }[] | null;
  section?: string | null;
  locator?: {
    cssSelector?: string;
    attributes?: Record<string, string>;
  } | null;
}

/** The structured result of generating one answer. */
export interface AnswerDraft {
  questionId: string;
  category: QuestionCategory;
  strategy: AnswerStrategy;
  /** null when no answer could be produced (e.g. missing facts). */
  answer: string | null;
  source: AnswerSource;
  /** 0-1. Conservative: high only for exact grounded facts. */
  confidence: number;
  /** Labels of the facts this answer is grounded in (provenance). */
  groundedFacts: string[];
  needsReview: boolean;
  /** Why the answer needs review / could not be produced. */
  reviewReason?: string | null;
  /** Non-sensitive reasoning metadata (never includes answer text). */
  reasoning?: string | null;
  /** Structured failure code when generation failed (never a success). */
  errorCode?: string | null;
}

/** Options for generating a single answer. */
export interface GenerateAnswerOptions {
  /** Injected AI provider (mocked in tests). null => AI questions need review. */
  aiProvider?: AiProvider | null;
  job?: JobContext | null;
}
