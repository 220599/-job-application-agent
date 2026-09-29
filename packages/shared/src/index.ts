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

export interface CandidateProfile {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedIn?: string;
  gitHub?: string;
  portfolio?: string;
  workAuthorization: string;
  sponsorshipRequired: boolean;
  yearsOfExperience: number;
  preferredRoles: string[];
  preferredLocations: string[];
  remotePreference: 'onsite' | 'hybrid' | 'remote' | 'any';
  salaryPreference?: {
    min?: number;
    max?: number;
    currency?: string;
  };
  skills: string[];
  education: Education[];
  experience: Experience[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Education {
  id: string;
  institution: string;
  degree: string;
  field: string;
  graduationDate: Date;
  grade?: string;
}

export interface Experience {
  id: string;
  company: string;
  title: string;
  startDate: Date;
  endDate?: Date;
  currentlyWorking: boolean;
  description: string;
  skills: string[];
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
