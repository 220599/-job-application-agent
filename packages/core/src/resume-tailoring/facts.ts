/**
 * Phase 11 - scoped tailoring context.
 *
 * The tailoring context is built ONLY from resume-relevant candidate data:
 * identity, contact, location, links, summary, desired roles, work
 * authorization when meaningful, experience, education, skills, and the source
 * resume's content. Salary expectations and other unrelated user data are
 * never included (the types do not even carry them).
 *
 * `corpus` is the deterministic vocabulary the validator trusts: every
 * generated skill, metric, date, and certification claim must be traceable to
 * it. Nothing here infers a missing fact.
 */
import { computeYearsOfExperience } from '../answer-generation/facts';
import type {
  SourceResumeContent,
  TailorEducationFacts,
  TailorExperienceFacts,
  TailorProfileFacts,
  TailorSkillFacts,
  TailoringContext,
} from './types';

export interface TailoringRecords {
  profile?: TailorProfileFacts | null;
  experience?: TailorExperienceFacts[];
  education?: TailorEducationFacts[];
  skills?: TailorSkillFacts[];
  source?: SourceResumeContent | null;
}

function isMeaningful(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim() !== '' && v.trim().toUpperCase() !== 'OTHER';
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function locationString(profile: TailorProfileFacts): string | null {
  if (isMeaningful(profile.location)) return profile.location!.trim();
  const parts = [profile.city, profile.state, profile.country].filter(isMeaningful);
  return parts.length > 0 ? parts.join(', ') : null;
}

function experienceFactLine(exp: TailorExperienceFacts): string {
  const start = toDate(exp.startDate);
  const startStr = start ? start.toISOString().slice(0, 7) : 'unknown';
  const endStr = exp.isCurrent ? 'Present' : toDate(exp.endDate)?.toISOString().slice(0, 7) ?? 'Present';
  return `${exp.title} at ${exp.company} (${startStr} - ${endStr})`;
}

function educationFactLine(edu: TailorEducationFacts): string {
  const field = isMeaningful(edu.fieldOfStudy) ? ` in ${edu.fieldOfStudy}` : '';
  return `${edu.degree}${field}, ${edu.institution}`;
}

function parsedDataText(parsedData: Record<string, unknown> | null | undefined): string {
  if (!parsedData) return '';
  try {
    return JSON.stringify(parsedData);
  } catch {
    return '';
  }
}

/**
 * Deterministic year span shown in prompts and allowed as a generated metric:
 * the floor of the merged-experience years. It is a fact because it is derived
 * from stored employment dates - never guessed.
 */
export function derivedYearsLabel(years: number | null): string | null {
  if (years === null || !Number.isFinite(years)) return null;
  const whole = Math.floor(years);
  return `${whole} years`;
}

/**
 * Build the scoped tailoring context. The `corpus` is the union of every
 * grounded fact line, the source resume content, and derived values - the
 * complete set of text the generated resume is allowed to reference.
 */
export function buildTailoringContext(records: TailoringRecords): TailoringContext {
  const profile = records.profile ?? null;
  const experience = records.experience ?? [];
  const education = records.education ?? [];
  const skills = records.skills ?? [];
  const source = records.source ?? { extractedText: null, parsedData: null };

  const lines: string[] = [];

  if (profile) {
    lines.push(`Name: ${profile.firstName} ${profile.lastName}`);
    if (isMeaningful(profile.preferredName)) lines.push(`Preferred name: ${profile.preferredName}`);
    lines.push(`Email: ${profile.email}`);
    if (isMeaningful(profile.phone)) lines.push(`Phone: ${profile.phone}`);
    const loc = locationString(profile);
    if (loc) lines.push(`Location: ${loc}`);
    if (isMeaningful(profile.linkedinUrl)) lines.push(`LinkedIn: ${profile.linkedinUrl}`);
    if (isMeaningful(profile.githubUrl)) lines.push(`GitHub: ${profile.githubUrl}`);
    if (isMeaningful(profile.portfolioUrl)) lines.push(`Portfolio: ${profile.portfolioUrl}`);
    if (isMeaningful(profile.websiteUrl)) lines.push(`Website: ${profile.websiteUrl}`);
    if (isMeaningful(profile.summary)) lines.push(`Professional summary: ${profile.summary}`);
    if ((profile.desiredRoles ?? []).length > 0) {
      lines.push(`Desired roles: ${(profile.desiredRoles ?? []).join(', ')}`);
    }
    // Work authorization only when an explicit, meaningful status is stored.
    if (isMeaningful(profile.workAuthorization)) {
      lines.push(`Work authorization status: ${profile.workAuthorization}`);
    }
  }

  for (const exp of experience) lines.push(`Experience: ${experienceFactLine(exp)}`);
  if (experience.some((e) => isMeaningful(e.description))) {
    for (const exp of experience) {
      if (isMeaningful(exp.description)) lines.push(`Experience detail: ${exp.description}`);
    }
  }
  for (const edu of education) lines.push(`Education: ${educationFactLine(edu)}`);
  if (education.some((e) => isMeaningful(e.description))) {
    for (const edu of education) {
      if (isMeaningful(edu.description)) lines.push(`Education detail: ${edu.description}`);
    }
  }
  if (skills.length > 0) lines.push(`Skills: ${skills.map((s) => s.name).join(', ')}`);
  for (const s of skills) {
    if (typeof s.yearsOfExperience === 'number' && Number.isFinite(s.yearsOfExperience)) {
      lines.push(`${s.name}: ${Math.floor(s.yearsOfExperience)} years of experience`);
    }
  }

  const yearsOfExperience = computeYearsOfExperience(experience);
  const yearsLabel = derivedYearsLabel(yearsOfExperience);
  if (yearsLabel) lines.push(`Total experience: ${yearsLabel}`);

  if (isMeaningful(source.extractedText)) lines.push(`Source resume text: ${source.extractedText}`);
  const parsedText = parsedDataText(source.parsedData);
  if (parsedText !== '') lines.push(`Source resume structured data: ${parsedText}`);

  return {
    profile,
    experience,
    education,
    skills,
    source: {
      extractedText: source.extractedText ?? null,
      parsedData: source.parsedData ?? null,
    },
    yearsOfExperience,
    corpus: lines.join('\n').toLowerCase(),
  };
}
