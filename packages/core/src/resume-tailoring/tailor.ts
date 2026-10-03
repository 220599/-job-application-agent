/**
 * Phase 11 - resume tailoring orchestration.
 *
 * Pipeline:
 *   load source version -> load candidate facts -> load job -> scoped context
 *     -> grounded AI generation (structured contract, via @jaa/ai)
 *     -> deterministic anti-fabrication validation
 *     -> create NEW immutable ResumeVersion (source = TAILORED)
 *     -> result (READY FOR HUMAN REVIEW)
 *
 * Safe failure is a hard guarantee: on any AI failure or validation failure no
 * ResumeVersion is created, the source version is untouched, and a structured
 * error (code + violations) is raised. There are no permissive retries.
 *
 * Idempotency: (user, job, source version, strategy) identifies a tailoring
 * request. A previous valid result for the same identity is reused unless
 * `regenerate` requests a deliberate new run.
 *
 * Audit: RESUME_TAILORED / ERROR events are recorded on the user's Application
 * for the target job when one exists. Event metadata never contains resume
 * text, prompts, AI responses, or personal data.
 */
import { prisma } from '@jaa/database';
import type { Prisma } from '@prisma/client';
import { AiError, getDefaultAiProvider, type AiProvider } from '@jaa/ai';

import type {
  TailoredResumeContent,
  TailoringContext,
  TailoringProvenance,
  TailoringValidationResult,
  TailorJobContext,
  TailorResumeParams,
  TailorResumeResult,
  ResumeTailoringErrorCode,
} from './types';
import { ResumeTailoringError, TAILORING_STRATEGY } from './types';
import { buildTailoringContext } from './facts';
import { buildTailoringPrompt } from './prompt';
import { parseTailoredContent, toTailoredContent, validateTailoredContent } from './validate';
import { buildProvenance, createTailoredVersion, type TailoredVersionRecord } from './version';

// ============================================================================
// AI tailoring (no DB) - reusable and unit-testable
// ============================================================================

export interface TailorContentParams {
  ctx: TailoringContext;
  job: TailorJobContext | null | undefined;
  aiProvider: AiProvider | null | undefined;
}

export interface TailorContentResult {
  content: TailoredResumeContent | null;
  validation: TailoringValidationResult | null;
  provider: string | null;
  model?: string;
  errorCode: ResumeTailoringErrorCode | null;
  violations: TailoringValidationResult['violations'];
}

/**
 * Run the AI tailoring step and validate its output. Pure with respect to the
 * database: failures are returned as structured codes and never throw.
 */
export async function tailorResumeContent(params: TailorContentParams): Promise<TailorContentResult> {
  const { ctx, job, aiProvider } = params;

  if (!aiProvider) {
    return {
      content: null,
      validation: null,
      provider: null,
      errorCode: 'AI_PROVIDER_UNAVAILABLE',
      violations: [],
    };
  }

  const prompt = buildTailoringPrompt(ctx, job);

  let raw: string;
  let providerName = aiProvider.name;
  let model: string | undefined;
  try {
    const result = await aiProvider.generate({ prompt, options: { temperature: 0.2 } });
    raw = result.text ?? '';
    providerName = result.provider ?? providerName;
    model = result.model;
  } catch (err) {
    const code: ResumeTailoringErrorCode =
      err instanceof AiError && isAiErrorCode(err.code) ? err.code : 'AI_REQUEST_FAILED';
    return { content: null, validation: null, provider: providerName, model, errorCode: code, violations: [] };
  }

  const parsed = parseTailoredContent(raw);
  if (parsed.error !== null || parsed.content === null) {
    const code: ResumeTailoringErrorCode = (parsed.error ?? 'AI_INVALID_RESPONSE') as ResumeTailoringErrorCode;
    return { content: null, validation: null, provider: providerName, model, errorCode: code, violations: [] };
  }

  const validation = validateTailoredContent(parsed.content, ctx);
  if (!validation.valid) {
    return {
      content: null,
      validation,
      provider: providerName,
      model,
      errorCode: 'VALIDATION_FAILED',
      violations: validation.violations,
    };
  }

  return {
    content: toTailoredContent(parsed.content),
    validation,
    provider: providerName,
    model,
    errorCode: null,
    violations: [],
  };
}

function isAiErrorCode(code: string): code is
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_EMPTY_RESPONSE'
  | 'AI_INVALID_RESPONSE'
  | 'AI_REQUEST_FAILED' {
  return [
    'AI_PROVIDER_UNAVAILABLE',
    'AI_RATE_LIMITED',
    'AI_TIMEOUT',
    'AI_EMPTY_RESPONSE',
    'AI_INVALID_RESPONSE',
    'AI_REQUEST_FAILED',
  ].includes(code);
}

// ============================================================================
// Database workflow
// ============================================================================

function toJobContext(job: {
  id: string;
  company: string;
  title: string;
  location: string | null;
  description: string | null;
  employmentType: string | null;
  workMode: string | null;
  requirements: unknown;
  responsibilities: unknown;
  skills: unknown;
}): TailorJobContext {
  const arr = (v: unknown): string[] | null => (Array.isArray(v) ? (v as string[]) : null);
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    description: job.description,
    employmentType: job.employmentType,
    workMode: job.workMode,
    requirements: arr(job.requirements),
    responsibilities: arr(job.responsibilities),
    skills: arr(job.skills),
  };
}

/** Reconstruct the structured content from a stored tailored version. */
function contentFromParsedData(parsedData: Record<string, unknown> | null): TailoredResumeContent {
  if (!parsedData) return {};
  const content: TailoredResumeContent = {};
  if (typeof parsedData['summary'] === 'string') content.summary = parsedData['summary'];
  if (Array.isArray(parsedData['skills'])) {
    content.skills = (parsedData['skills'] as unknown[]).filter((s): s is string => typeof s === 'string');
  }
  if (Array.isArray(parsedData['experience'])) {
    content.experience = (parsedData['experience'] as unknown[])
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map((e) => ({
        ...(typeof e['id'] === 'string' ? { experienceId: e['id'] } : {}),
        company: String(e['company'] ?? ''),
        title: String(e['title'] ?? ''),
        bullets: Array.isArray(e['bullets'])
          ? (e['bullets'] as unknown[]).filter((b): b is string => typeof b === 'string')
          : typeof e['description'] === 'string'
            ? (e['description'] as string).split('\n').map((l) => l.replace(/^-\s*/, '')).filter((l) => l.trim() !== '')
            : [],
      }));
  }
  if (Array.isArray(parsedData['education'])) {
    content.education = (parsedData['education'] as unknown[])
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map((e) => ({
        ...(typeof e['id'] === 'string' ? { educationId: e['id'] } : {}),
        institution: String(e['institution'] ?? ''),
        degree: String(e['degree'] ?? ''),
        fieldOfStudy: String(e['fieldOfStudy'] ?? ''),
        ...(Array.isArray(e['details'])
          ? { details: (e['details'] as unknown[]).filter((d): d is string => typeof d === 'string') }
          : {}),
      }));
  }
  return content;
}

function storedTailoring(version: { tailoring: unknown }): TailoringProvenance | null {
  const t = version.tailoring;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    return t as TailoringProvenance;
  }
  return null;
}

function matchesIdentity(prov: TailoringProvenance | null, sourceVersionId: string, jobId: string): boolean {
  return (
    prov !== null &&
    prov.sourceVersionId === sourceVersionId &&
    prov.jobId === jobId &&
    prov.strategy === TAILORING_STRATEGY &&
    prov.validationStatus === 'PASSED'
  );
}

async function auditEvent(params: {
  userId: string;
  jobId: string;
  eventType: 'RESUME_TAILORED' | 'ERROR';
  message: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  // ApplicationEvent is application-scoped; record on the user's Application
  // for the target job when one exists. Provenance is always persisted on the
  // tailored version itself (see ResumeVersion.tailoring).
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
      message: params.message,
      metadata: params.metadata as Prisma.InputJsonValue,
    },
  });
}

function toVersionRecord(version: TailoredVersionRecord): TailorResumeResult['version'] {
  return {
    id: version.id,
    resumeId: version.resumeId,
    versionNumber: version.versionNumber,
    filePath: version.filePath,
    source: version.source,
    changeSummary: version.changeSummary,
  };
}

/**
 * Tailor a ResumeVersion toward a Job and persist the result as a NEW
 * immutable ResumeVersion.
 *
 * Guarantees:
 *  - ownership is enforced when `userId` is supplied (mismatch -> *_NOT_FOUND,
 *    indistinguishable from non-existence);
 *  - the source version is NEVER modified (no update call touches it);
 *  - AI failure / validation failure -> no version created, structured error;
 *  - idempotent per (user, job, source version, strategy) unless `regenerate`;
 *  - version numbers are strictly increasing and never reused.
 */
export async function tailorResumeVersion(params: TailorResumeParams): Promise<TailorResumeResult> {
  const resume = await prisma.resume.findUnique({ where: { id: params.resumeId } });
  if (!resume || (params.userId && resume.userId !== params.userId)) {
    throw new ResumeTailoringError('RESUME_NOT_FOUND', 'Resume not found');
  }

  const sourceVersion = await prisma.resumeVersion.findFirst({
    where: { id: params.versionId, resumeId: params.resumeId },
  });
  if (!sourceVersion) {
    throw new ResumeTailoringError('VERSION_NOT_FOUND', 'Resume version not found');
  }

  const job = await prisma.job.findUnique({ where: { id: params.jobId } });
  if (!job || (params.userId && job.userId !== params.userId)) {
    throw new ResumeTailoringError('JOB_NOT_FOUND', 'Job not found');
  }

  const sourceText = sourceVersion.extractedText?.trim() ?? '';
  const sourceParsed = (sourceVersion.parsedData as Record<string, unknown> | null) ?? null;
  if (sourceText === '' && (sourceParsed === null || Object.keys(sourceParsed).length === 0)) {
    throw new ResumeTailoringError(
      'EMPTY_RESUME_CONTENT',
      'Source resume version has no usable content to tailor'
    );
  }

  // Idempotency: reuse a previous valid tailoring for the same identity.
  if (!params.regenerate) {
    const priorVersions = await prisma.resumeVersion.findMany({
      where: { resumeId: params.resumeId, source: 'TAILORED' },
      orderBy: { versionNumber: 'desc' },
    });
    const prior = priorVersions.find((v) =>
      matchesIdentity(storedTailoring(v), sourceVersion.id, job.id)
    );
    if (prior) {
      return {
        reused: true,
        version: toVersionRecord({
          id: prior.id,
          resumeId: prior.resumeId,
          versionNumber: prior.versionNumber,
          filePath: prior.filePath,
          source: prior.source,
          changeSummary: prior.changeSummary,
        }),
        content: contentFromParsedData((prior.parsedData as Record<string, unknown> | null) ?? null),
        validation: { valid: true, violations: [] },
        provenance: storedTailoring(prior)!,
      };
    }
  }

  const profile = await prisma.candidateProfile.findUnique({
    where: { userId: resume.userId },
    include: { experience: true, education: true, skills: true },
  });

  const ctx = buildTailoringContext({
    profile: profile
      ? {
          firstName: profile.firstName,
          lastName: profile.lastName,
          preferredName: profile.preferredName,
          email: profile.email,
          phone: profile.phone,
          location: profile.location,
          city: profile.city,
          state: profile.state,
          country: profile.country,
          linkedinUrl: profile.linkedinUrl,
          githubUrl: profile.githubUrl,
          portfolioUrl: profile.portfolioUrl,
          websiteUrl: profile.websiteUrl,
          workAuthorization: profile.workAuthorization,
          desiredRoles: profile.desiredRoles,
          summary: profile.summary,
        }
      : null,
    experience: profile?.experience ?? [],
    education: profile?.education ?? [],
    skills: profile?.skills ?? [],
    source: { extractedText: sourceText === '' ? null : sourceText, parsedData: sourceParsed },
  });

  const jobContext = toJobContext(job);
  const outcome = await tailorResumeContent({
    ctx,
    job: jobContext,
    // undefined -> resolve the configured default provider; explicit null ->
    // no provider (a structured failure follows, never fabricated content).
    aiProvider: params.aiProvider === undefined ? getDefaultAiProvider() : params.aiProvider,
  });

  if (outcome.errorCode !== null || outcome.content === null) {
    const code = outcome.errorCode ?? 'AI_INVALID_RESPONSE';
    await auditEvent({
      userId: resume.userId,
      jobId: job.id,
      eventType: 'ERROR',
      message: `Resume tailoring failed (${code})`,
      metadata: {
        sourceVersionId: sourceVersion.id,
        jobId: job.id,
        strategy: TAILORING_STRATEGY,
        code,
        violationTypes: outcome.violations.map((v) => v.type),
      },
    });
    throw new ResumeTailoringError(
      code,
      code === 'VALIDATION_FAILED'
        ? 'Generated resume contains claims not supported by the candidate facts'
        : `Resume tailoring failed (${code})`,
      { violations: outcome.violations }
    );
  }

  const provenance = buildProvenance({
    sourceVersionId: sourceVersion.id,
    jobId: job.id,
    provider: outcome.provider ?? 'unknown',
    ...(outcome.model ? { model: outcome.model } : {}),
  });

  const version = await createTailoredVersion({
    resumeId: resume.id,
    userId: resume.userId,
    job: { title: job.title, company: job.company },
    content: outcome.content,
    ctx,
    provenance,
    storeArtifact: params.storeArtifact,
  });

  await auditEvent({
    userId: resume.userId,
    jobId: job.id,
    eventType: 'RESUME_TAILORED',
    message: `Resume tailored (${TAILORING_STRATEGY})`,
    metadata: {
      sourceVersionId: sourceVersion.id,
      targetVersionId: version.id,
      jobId: job.id,
      strategy: TAILORING_STRATEGY,
      validationStatus: 'PASSED',
    },
  });

  return {
    reused: false,
    version: toVersionRecord(version),
    content: outcome.content,
    validation: outcome.validation ?? { valid: true, violations: [] },
    provenance,
  };
}
