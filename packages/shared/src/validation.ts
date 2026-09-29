import { z } from 'zod';

// User
export const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Candidate Profile
export const candidateProfileCreateSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  preferredName: z.string().optional(),
  email: z.string().email(),
  phone: z.string().optional(),
  location: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  zipCode: z.string().optional(),
  linkedinUrl: z.string().url().optional().or(z.literal('')),
  githubUrl: z.string().url().optional().or(z.literal('')),
  portfolioUrl: z.string().url().optional().or(z.literal('')),
  websiteUrl: z.string().url().optional().or(z.literal('')),
  workAuthorization: z.string().default('OTHER'),
  sponsorshipRequired: z.boolean().default(false),
  willingToRelocate: z.boolean().default(false),
  preferredWorkMode: z.enum(['REMOTE', 'HYBRID', 'ONSITE', 'ANY']).default('ANY'),
  preferredLocations: z.array(z.string()).default([]),
  desiredRoles: z.array(z.string()).default([]),
  desiredSalaryMin: z.number().int().min(0).optional(),
  desiredSalaryMax: z.number().int().min(0).optional(),
  summary: z.string().optional(),
});

export const candidateProfileUpdateSchema = candidateProfileCreateSchema.partial();

export type CandidateProfileCreate = z.infer<typeof candidateProfileCreateSchema>;
export type CandidateProfileUpdate = z.infer<typeof candidateProfileUpdateSchema>;

// Education
export const educationCreateSchema = z.object({
  institution: z.string().min(1),
  degree: z.string().min(1),
  fieldOfStudy: z.string().min(1),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  gpa: z.number().min(0).max(4).optional(),
  description: z.string().optional(),
});

export const educationUpdateSchema = educationCreateSchema.partial();

export type EducationCreate = z.infer<typeof educationCreateSchema>;
export type EducationUpdate = z.infer<typeof educationUpdateSchema>;

// Experience
export const experienceCreateSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  location: z.string().optional(),
  employmentType: z.string().default('FULL_TIME'),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  isCurrent: z.boolean().default(false),
  description: z.string().optional(),
});

export const experienceUpdateSchema = experienceCreateSchema.partial();

export type ExperienceCreate = z.infer<typeof experienceCreateSchema>;
export type ExperienceUpdate = z.infer<typeof experienceUpdateSchema>;

// Skill
export const skillCreateSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  proficiency: z.string().default('INTERMEDIATE'),
  yearsOfExperience: z.number().min(0).optional(),
});

export const skillUpdateSchema = skillCreateSchema.partial();

export type SkillCreate = z.infer<typeof skillCreateSchema>;
export type SkillUpdate = z.infer<typeof skillUpdateSchema>;

// Pagination
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationSchema>;

// API Response
export const apiResponseSchema = z.object({
  data: z.any(),
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.any()).optional(),
  }),
});

// Resume
export const resumeCreateSchema = z.object({
  name: z.string().min(1),
  originalFileName: z.string().min(1),
  fileType: z.enum(['pdf', 'docx']).default('pdf'),
  storageKey: z.string().min(1),
  fileSize: z.number().int().min(1),
  mimeType: z.string(),
  isDefault: z.boolean().default(false),
});

export type ResumeCreate = z.infer<typeof resumeCreateSchema>;

// Job
export const jobCreateSchema = z.object({
  externalId: z.string().optional(),
  source: z.string().default('UNKNOWN'),
  ats: z.string().optional(),
  url: z.string().url(),
  company: z.string().min(1),
  title: z.string().min(1),
  location: z.string().optional(),
  description: z.string().optional(),
  employmentType: z.string().optional(),
  workMode: z.string().optional(),
  salaryMin: z.number().int().min(0).optional(),
  salaryMax: z.number().int().min(0).optional(),
  salaryCurrency: z.string().default('USD'),
  requirements: z.array(z.string()).optional(),
  responsibilities: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  postedAt: z.coerce.date().optional(),
});

export type JobCreate = z.infer<typeof jobCreateSchema>;

// Application Status
export const applicationStatusEnum = z.enum([
  'DISCOVERED',
  'MATCHED',
  'PREPARING',
  'FORM_INSPECTED',
  'FORM_FILLED',
  'READY_FOR_REVIEW',
  'APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'FAILED',
  'WITHDRAWN',
  'REJECTED',
  'INTERVIEW',
  'OFFER',
]);

export const applicationCreateSchema = z.object({
  jobId: z.string(),
  resumeVersionId: z.string(),
  ats: z.string(),
  applicationUrl: z.string().url().optional(),
  status: applicationStatusEnum.default('DISCOVERED'),
});

export type ApplicationCreate = z.infer<typeof applicationCreateSchema>;
