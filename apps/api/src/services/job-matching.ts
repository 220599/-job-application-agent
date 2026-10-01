/**
 * Phase 5 - Job Matching service
 *
 * Prisma-facing wrapper around the deterministic engine in
 * job-matching-core.ts. Loads the candidate's stored data, computes the
 * match, and persists it in the JobMatch table (upsert, one per user+job).
 *
 * The scoring itself never touches the database or an AI API: see
 * calculateJobMatch -> computeJobMatch (pure). An AI enrichment layer can
 * later be plugged in via the MatchExplainer interface without changing
 * any of the scoring logic.
 */
import { prisma } from '@jaa/database';
import type { JobMatch } from '@jaa/database';
import type { Prisma } from '@prisma/client';
import {
  computeJobMatch,
  noopExplainer,
  type MatchExplainer,
  type MatchInput,
} from './job-matching-core';

export { MATCH_WEIGHTS } from './job-matching-core';export type {
  MatchComputation,
  MatchCriterion,
  MatchFactorResult,
  MatchFactorStatus,
} from './job-matching-core';

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Serialize a JobMatch row for the API. `overallScore`/`concerns` are
 * exposed as aliases of `score`/`warnings` so the API contract matches the
 * Phase 5 spec while the database columns keep their existing names.
 */
export function serializeJobMatch(row: JobMatch) {
  return {
    id: row.id,
    jobId: row.jobId,
    userId: row.userId,
    score: row.score,
    overallScore: row.score,
    skillsScore: row.skillsScore,
    roleScore: row.roleScore,
    experienceScore: row.experienceScore,
    locationScore: row.locationScore,
    salaryScore: row.salaryScore,
    authorizationScore: row.authorizationScore,
    workAuthorizationScore: row.authorizationScore,
    matchedSkills: toStringArray(row.matchedSkills),
    missingSkills: toStringArray(row.missingSkills),
    matchedCriteria: Array.isArray(row.matchedCriteria) ? row.matchedCriteria : [],
    strengths: toStringArray(row.strengths),
    gaps: toStringArray(row.gaps),
    warnings: toStringArray(row.warnings),
    concerns: toStringArray(row.warnings),
    explanation: row.explanation,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type SerializedJobMatch = ReturnType<typeof serializeJobMatch>;

/**
 * Explanation/enrichment hook for a future AI layer. Defaults to a no-op;
 * the deterministic score never depends on it.
 */
let activeExplainer: MatchExplainer = noopExplainer;

export function setMatchExplainer(explainer: MatchExplainer): void {
  activeExplainer = explainer;
}

export class MatchServiceError extends Error {
  constructor(
    public code: 'JOB_NOT_FOUND' | 'PROFILE_NOT_FOUND' | 'MATCH_NOT_FOUND',
    message: string
  ) {
    super(message);
    this.name = 'MatchServiceError';
  }
}

/** Calculate (or recalculate) and persist the match for one user+job. */
export async function calculateJobMatch(userId: string, jobId: string): Promise<SerializedJobMatch> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || job.userId !== userId) {
    throw new MatchServiceError('JOB_NOT_FOUND', 'Job not found');
  }

  const profile = await prisma.candidateProfile.findUnique({
    where: { userId },
    include: {
      skills: { orderBy: { createdAt: 'asc' } },
      experience: { orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }] },
    },
  });

  if (!profile) {
    throw new MatchServiceError(
      'PROFILE_NOT_FOUND',
      'Create your candidate profile before calculating job matches'
    );
  }

  const input: MatchInput = {
    job: {
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description,
      employmentType: job.employmentType,
      workMode: job.workMode,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      salaryCurrency: job.salaryCurrency,
      requirements: toStringArray(job.requirements),
      responsibilities: toStringArray(job.responsibilities),
      skills: toStringArray(job.skills),
    },
    profile: {
      workAuthorization: profile.workAuthorization,
      sponsorshipRequired: profile.sponsorshipRequired,
      willingToRelocate: profile.willingToRelocate,
      preferredWorkMode: profile.preferredWorkMode,
      preferredLocations: profile.preferredLocations,
      desiredRoles: profile.desiredRoles,
      desiredSalaryMin: profile.desiredSalaryMin,
      desiredSalaryMax: profile.desiredSalaryMax,
      city: profile.city,
      state: profile.state,
      country: profile.country,
    },
    skills: profile.skills.map((s) => ({
      name: s.name,
      proficiency: s.proficiency,
      yearsOfExperience: s.yearsOfExperience,
    })),
    experience: profile.experience.map((e) => ({
      company: e.company,
      title: e.title,
      employmentType: e.employmentType,
      description: e.description,
      isCurrent: e.isCurrent,
    })),
  };

  const computation = computeJobMatch(input);

  // Hook for a future AI enrichment layer (no-op today; never blocks scoring).
  const aiExplanation = await activeExplainer.enrich(computation, input).catch(() => null);

  const data = {
    score: computation.overallScore,
    skillsScore: computation.factors.find((f) => f.key === 'skills')?.score ?? null,
    roleScore: computation.factors.find((f) => f.key === 'role')?.score ?? null,
    experienceScore: computation.factors.find((f) => f.key === 'experience')?.score ?? null,
    locationScore: computation.factors.find((f) => f.key === 'location')?.score ?? null,
    salaryScore: computation.factors.find((f) => f.key === 'salary')?.score ?? null,
    authorizationScore:
      computation.factors.find((f) => f.key === 'employmentAuthorization')?.score ?? null,
    strengths: computation.strengths as unknown as Prisma.InputJsonValue,
    gaps: computation.gaps as unknown as Prisma.InputJsonValue,
    warnings: computation.concerns as unknown as Prisma.InputJsonValue,
    matchedSkills: computation.matchedSkills as unknown as Prisma.InputJsonValue,
    missingSkills: computation.missingSkills as unknown as Prisma.InputJsonValue,
    matchedCriteria: computation.matchedCriteria as unknown as Prisma.InputJsonValue,
    explanation: aiExplanation ?? computation.explanation,
  };

  const saved = await prisma.jobMatch.upsert({
    where: { userId_jobId: { userId, jobId } },
    update: data,
    create: { userId, jobId, ...data },
  });

  return serializeJobMatch(saved);
}

/** Return the stored match for one job, without recalculating. */
export async function getJobMatch(userId: string, jobId: string): Promise<SerializedJobMatch> {
  const match = await prisma.jobMatch.findUnique({
    where: { userId_jobId: { userId, jobId } },
  });
  if (!match) {
    throw new MatchServiceError('MATCH_NOT_FOUND', 'No match calculated for this job yet');
  }
  return serializeJobMatch(match);
}

/** Return all of the user's matches, best first, with their jobs attached. */
export async function listJobMatches(userId: string) {
  const matches = await prisma.jobMatch.findMany({
    where: { userId },
    include: { job: true },
    orderBy: { score: 'desc' },
  });
  return matches.map((m) => ({
    ...serializeJobMatch(m),
    job: {
      id: m.job.id,
      title: m.job.title,
      company: m.job.company,
      location: m.job.location,
      url: m.job.url,
      workMode: m.job.workMode,
      employmentType: m.job.employmentType,
      source: m.job.source,
    },
  }));
}
