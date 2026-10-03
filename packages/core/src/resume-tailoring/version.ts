/**
 * Phase 11 - immutable ResumeVersion creation for tailored content.
 *
 * Tailoring ALWAYS creates a NEW ResumeVersion (source = TAILORED) and never
 * touches the source version. Version numbers are strictly increasing per
 * resume (never reused) and creation retries on the (resumeId, versionNumber)
 * unique constraint. Dates and contact details in the generated version always
 * come from the stored candidate facts - never from the model.
 *
 * The tailored artifact is stored as structured content (JSON) using the
 * existing local-file storage convention; `parsedData` keeps a
 * ParsedProfile-compatible structure so later phases can render PDF/DOCX
 * without any new data model. No document-rendering architecture is
 * introduced here.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { prisma } from '@jaa/database';
import type { Prisma } from '@prisma/client';
import type {
  TailoredEducationEntry,
  TailoredExperienceEntry,
  TailoredResumeContent,
  TailorArtifactStore,
  TailorEducationFacts,
  TailorExperienceFacts,
  TailorJobContext,
  TailoringContext,
  TailoringProvenance,
} from './types';
import { TAILORING_STRATEGY } from './types';
import { TAILORING_PROMPT_VERSION } from './prompt';

// ============================================================================
// Source-fact resolution (dates/contact can only come from the source data)
// ============================================================================

function toMonth(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 7);
}

export function changeSummaryFor(job: Pick<TailorJobContext, 'title' | 'company'>): string {
  return `Tailored for ${job.title} role at ${job.company}`;
}

/**
 * Find the source experience record a generated entry corresponds to. The
 * validator already guarantees company/title correspond to a stored record;
 * this recovers the authoritative dates and details for the new version.
 */
export function resolveSourceExperience(
  entry: TailoredExperienceEntry,
  ctx: TailoringContext
): TailorExperienceFacts | null {
  const fromParsed = (ctx.source.parsedData?.['experience'] ?? []) as unknown[];
  const parsedMatch = fromParsed.find((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const e = raw as Record<string, unknown>;
    return (
      typeof e['company'] === 'string' &&
      typeof e['title'] === 'string' &&
      e['company'].toLowerCase() === entry.company.toLowerCase() &&
      e['title'].toLowerCase() === entry.title.toLowerCase()
    );
  }) as Record<string, unknown> | undefined;

  const dbMatch = ctx.experience.find(
    (e) =>
      (entry.experienceId && e.id === entry.experienceId) ||
      (e.company.toLowerCase() === entry.company.toLowerCase() &&
        e.title.toLowerCase() === entry.title.toLowerCase())
  );
  if (dbMatch) return dbMatch;
  if (parsedMatch) {
    return {
      company: parsedMatch['company'] as string,
      title: parsedMatch['title'] as string,
      startDate: (parsedMatch['startDate'] as string) ?? '',
      endDate: (parsedMatch['endDate'] as string) ?? null,
      isCurrent: parsedMatch['isCurrent'] === true,
      description: (parsedMatch['description'] as string) ?? null,
    };
  }
  return null;
}

export function resolveSourceEducation(
  entry: TailoredEducationEntry,
  ctx: TailoringContext
): TailorEducationFacts | null {
  const dbMatch = ctx.education.find(
    (e) =>
      (entry.educationId && e.id === entry.educationId) ||
      (e.institution.toLowerCase() === entry.institution.toLowerCase() &&
        e.degree.toLowerCase() === entry.degree.toLowerCase())
  );
  return dbMatch ?? null;
}

// ============================================================================
// Rendering (deterministic; no AI, no formatting libraries)
// ============================================================================

/** Render the tailored content as plain text for `ResumeVersion.extractedText`. */
export function renderTailoredText(content: TailoredResumeContent, ctx: TailoringContext): string {
  const lines: string[] = [];
  const p = ctx.profile;
  if (p) {
    lines.push([p.preferredName || p.firstName, p.lastName].filter(Boolean).join(' '));
    const contact = [p.email, p.phone, p.location].filter(Boolean).join(' | ');
    if (contact) lines.push(contact);
    const links = [p.linkedinUrl, p.githubUrl, p.portfolioUrl, p.websiteUrl].filter(Boolean).join(' | ');
    if (links) lines.push(links);
    lines.push('');
  }
  if (content.summary) {
    lines.push('SUMMARY', content.summary, '');
  }
  if (content.skills && content.skills.length > 0) {
    lines.push('SKILLS', content.skills.join(', '), '');
  }
  if (content.experience && content.experience.length > 0) {
    lines.push('EXPERIENCE');
    for (const entry of content.experience) {
      const source = resolveSourceExperience(entry, ctx);
      const start = toMonth(source?.startDate) ?? '';
      const end = source?.isCurrent ? 'Present' : toMonth(source?.endDate) ?? 'Present';
      lines.push(`${entry.title} at ${entry.company} (${start} - ${end})`);
      for (const bullet of entry.bullets) lines.push(`- ${bullet}`);
      lines.push('');
    }
  }
  if (content.education && content.education.length > 0) {
    lines.push('EDUCATION');
    for (const entry of content.education) {
      const field = entry.fieldOfStudy ? ` in ${entry.fieldOfStudy}` : '';
      lines.push(`${entry.degree}${field}, ${entry.institution}`);
      for (const detail of entry.details ?? []) lines.push(`- ${detail}`);
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd();
}

/**
 * Assemble the new version's `parsedData`: a ParsedProfile-compatible structure
 * where contact info and dates come from the source facts (never the model)
 * and the tailored summary/skills/bullets come from the validated content.
 */
export function buildTailoredParsedData(
  content: TailoredResumeContent,
  ctx: TailoringContext
): Record<string, unknown> {
  const p = ctx.profile;
  return {
    firstName: p?.firstName ?? null,
    lastName: p?.lastName ?? null,
    email: p?.email ?? null,
    phone: p?.phone ?? null,
    location: p?.location ?? ([p?.city, p?.state, p?.country].filter(Boolean).join(', ') || null),
    linkedinUrl: p?.linkedinUrl ?? null,
    githubUrl: p?.githubUrl ?? null,
    portfolioUrl: p?.portfolioUrl ?? null,
    websiteUrl: p?.websiteUrl ?? null,
    summary: content.summary ?? null,
    skills: content.skills ?? [],
    experience: (content.experience ?? []).map((entry) => {
      const source = resolveSourceExperience(entry, ctx);
      return {
        ...(source?.id ? { id: source.id } : {}),
        company: entry.company,
        title: entry.title,
        location: source?.location ?? null,
        employmentType: source?.employmentType ?? null,
        startDate: toMonth(source?.startDate),
        endDate: source?.isCurrent ? null : toMonth(source?.endDate),
        isCurrent: source?.isCurrent === true,
        description: entry.bullets.join('\n'),
        bullets: entry.bullets,
      };
    }),
    education: (content.education ?? []).map((entry) => {
      const source = resolveSourceEducation(entry, ctx);
      return {
        ...(source?.id ? { id: source.id } : {}),
        institution: entry.institution,
        degree: entry.degree,
        fieldOfStudy: entry.fieldOfStudy,
        startDate: toMonth(source?.startDate),
        endDate: toMonth(source?.endDate),
        ...(entry.details ? { details: entry.details } : {}),
      };
    }),
    // Provenance marker for consumers: this version's content is structured
    // (rendered artifacts can be produced later without changing the model).
    contentFormat: 'STRUCTURED_JSON',
  };
}

// ============================================================================
// Artifact storage (existing local-file convention; injectable for tests)
// ============================================================================

/**
 * Default artifact store: writes the structured content as a JSON file using
 * the same local `uploads/resumes` convention as the original resume upload.
 */
export const defaultArtifactStore: TailorArtifactStore = async ({
  userId,
  resumeId,
  versionNumber,
  content,
  text,
}) => {
  const dir = path.join(process.cwd(), 'uploads', 'resumes');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${userId}-${Date.now()}-v${versionNumber}-tailored.json`);
  await fs.writeFile(
    filePath,
    JSON.stringify({ format: 'STRUCTURED_JSON', resumeId, versionNumber, content, text }, null, 2),
    'utf8'
  );
  return filePath;
};

// ============================================================================
// Provenance + version creation
// ============================================================================

export function buildProvenance(params: {
  sourceVersionId: string;
  jobId: string;
  provider: string;
  model?: string;
}): TailoringProvenance {
  return {
    sourceVersionId: params.sourceVersionId,
    jobId: params.jobId,
    strategy: TAILORING_STRATEGY,
    aiGenerated: true,
    provider: params.provider,
    ...(params.model ? { model: params.model } : {}),
    validationStatus: 'PASSED',
    contentFormat: 'STRUCTURED_JSON',
    promptVersion: TAILORING_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
  };
}

/** Next version number for a resume (strictly increasing, never reused). */
export async function nextVersionNumber(resumeId: string): Promise<number> {
  const agg = await prisma.resumeVersion.aggregate({
    where: { resumeId },
    _max: { versionNumber: true },
  });
  return (agg._max.versionNumber ?? 0) + 1;
}

export interface CreateTailoredVersionParams {
  resumeId: string;
  userId: string;
  job: Pick<TailorJobContext, 'title' | 'company'>;
  content: TailoredResumeContent;
  ctx: TailoringContext;
  provenance: TailoringProvenance;
  storeArtifact?: TailorArtifactStore;
}

export interface TailoredVersionRecord {
  id: string;
  resumeId: string;
  versionNumber: number;
  filePath: string;
  source: string;
  changeSummary: string | null;
}

/**
 * Create the new immutable tailored ResumeVersion. The source version is never
 * read for update here - only a fresh row is inserted. Concurrent creation
 * retries on the (resumeId, versionNumber) unique constraint so a version
 * number is never reused.
 */
export async function createTailoredVersion(
  params: CreateTailoredVersionParams
): Promise<TailoredVersionRecord> {
  const text = renderTailoredText(params.content, params.ctx);
  const parsedData = buildTailoredParsedData(params.content, params.ctx);
  const changeSummary = changeSummaryFor(params.job);
  const store = params.storeArtifact ?? defaultArtifactStore;

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const versionNumber = await nextVersionNumber(params.resumeId);
    const filePath = await store({
      userId: params.userId,
      resumeId: params.resumeId,
      versionNumber,
      content: params.content,
      text,
    });

    try {
      const version = await prisma.resumeVersion.create({
        data: {
          resumeId: params.resumeId,
          versionNumber,
          filePath,
          source: 'TAILORED',
          changeSummary,
          extractedText: text,
          parsedData: parsedData as unknown as Prisma.InputJsonValue,
          tailoring: params.provenance as unknown as Prisma.InputJsonValue,
        },
      });
      return {
        id: version.id,
        resumeId: version.resumeId,
        versionNumber: version.versionNumber,
        filePath: version.filePath,
        source: version.source,
        changeSummary: version.changeSummary,
      };
    } catch (err) {
      // P2002 on (resumeId, versionNumber): a concurrent writer took the
      // number. Never reuse it - recompute and retry.
      const code = (err as { code?: string })?.code;
      const isUnique = code === 'P2002' || /unique/i.test(String((err as Error)?.message ?? ''));
      if (isUnique && attempt < maxAttempts) continue;
      throw err;
    }
  }
  throw new Error('VERSION_CREATE_FAILED: could not create tailored version');
}
