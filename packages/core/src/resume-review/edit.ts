/**
 * Phase 12 - human corrections of tailored resume content.
 *
 * A human edit NEVER mutates an existing ResumeVersion. It produces a NEW
 * immutable version (source = USER_EDITED) whose provenance points at the
 * version it was derived from, so the history stays legible:
 *
 *   v1 ORIGINAL -> v2 TAILORED (sourceVersionId = v1)
 *               -> v3 USER_EDITED (sourceVersionId = v2)
 *
 * The Phase 11 anti-fabrication validator remains the authority over edited
 * content: a human can rephrase, reorder, remove, or restore claims, but any
 * claim not supported by the candidate facts / source resume is rejected with
 * structured violations and NO version is created. Dates and contact details
 * in the new version always come from the source facts - never from the edit.
 */
import { prisma } from '@jaa/database';
import type { Prisma } from '@prisma/client';
import {
  buildTailoringContext,
  buildTailoredParsedData,
  defaultArtifactStore,
  nextVersionNumber,
  renderTailoredText,
  toTailoredContent,
  validateTailoredContent,
  type TailoredResumeContent,
  type TailoringContext,
} from '../resume-tailoring';

import { loadReviewTarget, provenanceOf, reviewStateOf } from './review';
import {
  HUMAN_EDIT_STRATEGY,
  ResumeReviewError,
  type EditTailoredResumeParams,
  type EditTailoredResumeResult,
  type HumanEditProvenance,
} from './types';

/**
 * Walk the provenance chain to the root source version (the one without
 * tailoring provenance). Its content is the validation corpus base, exactly
 * like Phase 11 - so restoring a bullet from the original resume stays valid.
 */
async function findRootSourceVersion(
  resumeId: string,
  start: { id: string; tailoring: unknown }
): Promise<{ extractedText: string | null; parsedData: unknown }> {
  let current: { id: string; tailoring: unknown; extractedText: string | null; parsedData: unknown } = {
    id: start.id,
    tailoring: start.tailoring,
    extractedText: null,
    parsedData: null,
  };
  const row = await prisma.resumeVersion.findFirst({ where: { id: start.id, resumeId } });
  if (!row) return { extractedText: null, parsedData: null };
  current = { id: row.id, tailoring: row.tailoring, extractedText: row.extractedText, parsedData: row.parsedData };

  const seen = new Set<string>([current.id]);
  for (;;) {
    const prov = provenanceOf(current.tailoring);
    const parentId =
      prov && typeof prov['sourceVersionId'] === 'string' ? prov['sourceVersionId'] : null;
    if (parentId === null || seen.has(parentId)) break;
    seen.add(parentId);
    const parent = await prisma.resumeVersion.findFirst({ where: { id: parentId, resumeId } });
    if (!parent) break;
    current = {
      id: parent.id,
      tailoring: parent.tailoring,
      extractedText: parent.extractedText,
      parsedData: parent.parsedData,
    };
  }
  return { extractedText: current.extractedText, parsedData: current.parsedData };
}

/**
 * Create a human-edited derivative of a reviewable tailored version.
 *
 * Guarantees:
 *  - ownership enforced (mismatch -> RESUME_NOT_FOUND / VERSION_NOT_FOUND);
 *  - only reviewable versions (validated tailoring provenance) can be edited;
 *  - edited content passes the Phase 11 anti-fabrication validator or the
 *    call fails with VALIDATION_FAILED + violations and no version is created;
 *  - a NEW immutable version (USER_EDITED) is created with strictly increasing
 *    version numbers; the edited version and its source are never modified;
 *  - the new version starts in review state PENDING and must itself be
 *    approved before any later phase may use it.
 */
export async function createHumanEditedVersion(
  params: EditTailoredResumeParams
): Promise<EditTailoredResumeResult> {
  const target = await loadReviewTarget(params);
  const reviewer = params.userId ?? target.resume.userId;

  // Validation corpus: candidate facts + the ROOT source resume content -
  // identical in scope to what the Phase 11 validator trusted.
  const rootSource = await findRootSourceVersion(target.resume.id, {
    id: target.version.id,
    tailoring: target.version.tailoring,
  });

  const profile = await prisma.candidateProfile.findUnique({
    where: { userId: target.resume.userId },
    include: { experience: true, education: true, skills: true },
  });

  const ctx: TailoringContext = buildTailoringContext({
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
    source: {
      extractedText: rootSource.extractedText,
      parsedData: (rootSource.parsedData as Record<string, unknown> | null) ?? null,
    },
  });

  // The Phase 11 anti-fabrication validator is the authority - human edits
  // are never exempt.
  const validation = validateTailoredContent(params.content, ctx);
  if (!validation.valid) {
    throw new ResumeReviewError(
      'VALIDATION_FAILED',
      'Edited resume contains claims not supported by the candidate facts',
      { violations: validation.violations }
    );
  }
  const content: TailoredResumeContent = toTailoredContent(params.content);

  const text = renderTailoredText(content, ctx);
  const parsedData = buildTailoredParsedData(content, ctx);
  const changeSummary = `Human edits to tailored version v${target.version.versionNumber}`;
  const provenance: HumanEditProvenance = {
    sourceVersionId: target.version.id,
    jobId: target.provenance['jobId'] as string,
    strategy: HUMAN_EDIT_STRATEGY,
    aiGenerated: false,
    editedBy: reviewer,
    validationStatus: 'PASSED',
    contentFormat: 'STRUCTURED_JSON',
    generatedAt: new Date().toISOString(),
  };
  const store = params.storeArtifact ?? defaultArtifactStore;

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const versionNumber = await nextVersionNumber(target.resume.id);
    const filePath = await store({
      userId: target.resume.userId,
      resumeId: target.resume.id,
      versionNumber,
      content,
      text,
    });

    try {
      const version = await prisma.resumeVersion.create({
        data: {
          resumeId: target.resume.id,
          versionNumber,
          filePath,
          source: 'USER_EDITED',
          changeSummary,
          extractedText: text,
          parsedData: parsedData as unknown as Prisma.InputJsonValue,
          tailoring: provenance as unknown as Prisma.InputJsonValue,
        },
      });
      return {
        version: {
          id: version.id,
          resumeId: version.resumeId,
          versionNumber: version.versionNumber,
          filePath: version.filePath,
          source: version.source,
          changeSummary: version.changeSummary,
        },
        content,
        provenance,
        review: reviewStateOf(version),
      };
    } catch (err) {
      // P2002 on (resumeId, versionNumber): a concurrent writer took the
      // number. Never reuse it - recompute and retry.
      const code = (err as { code?: string })?.code;
      const isUnique =
        code === 'P2002' || /unique/i.test(String((err as Error)?.message ?? ''));
      if (isUnique && attempt < maxAttempts) continue;
      throw err;
    }
  }
  throw new Error('VERSION_CREATE_FAILED: could not create human-edited version');
}
