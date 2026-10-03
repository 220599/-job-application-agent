/**
 * Phase 10 - controlled candidate fact context.
 *
 * Facts are built ONLY from data that actually exists in the user's records.
 * Nothing here infers a missing fact. Per-category scoping (`relevantFacts`)
 * is the privacy control: a question only ever sees the facts it needs (a
 * LinkedIn question never receives the whole resume; a work-authorization
 * question never receives employment history).
 */
import type {
  CandidateContext,
  CandidateFact,
  EducationFacts,
  ExperienceFacts,
  ProfileFacts,
  QuestionCategory,
  ResumeFacts,
  SkillFacts,
} from './types';

export interface CandidateRecords {
  profile?: ProfileFacts | null;
  experience?: ExperienceFacts[];
  education?: EducationFacts[];
  skills?: SkillFacts[];
  resume?: ResumeFacts | null;
}

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isMeaningful(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim() !== '' && v.trim().toUpperCase() !== 'OTHER';
}

/**
 * Total distinct years of experience, computed deterministically by merging
 * overlapping experience date intervals. Returns null when no valid start
 * dates exist (nothing to calculate from - never guessed).
 */
export function computeYearsOfExperience(experiences: ExperienceFacts[]): number | null {
  const intervals: { start: number; end: number }[] = [];
  const now = Date.now();
  for (const exp of experiences) {
    const start = toDate(exp.startDate);
    if (!start) continue;
    const explicitEnd = toDate(exp.endDate);
    const end = exp.isCurrent || !explicitEnd ? now : explicitEnd.getTime();
    if (end < start.getTime()) continue;
    intervals.push({ start: start.getTime(), end });
  }
  if (intervals.length === 0) return null;

  intervals.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }
  const totalMs = merged.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  return totalMs / YEAR_MS;
}

function locationString(profile: ProfileFacts): string | null {
  if (isMeaningful(profile.location)) return profile.location!.trim();
  const parts = [profile.city, profile.state, profile.country].filter(isMeaningful);
  return parts.length > 0 ? parts.join(', ') : null;
}

function experienceLabel(exp: ExperienceFacts): string {
  const start = toDate(exp.startDate);
  const startStr = start ? start.toISOString().slice(0, 7) : 'unknown';
  const endStr = exp.isCurrent ? 'Present' : toDate(exp.endDate)?.toISOString().slice(0, 7) ?? 'Present';
  return `${exp.title} at ${exp.company} (${startStr} - ${endStr})`;
}

function educationLabel(edu: EducationFacts): string {
  const field = isMeaningful(edu.fieldOfStudy) ? ` in ${edu.fieldOfStudy}` : '';
  return `${edu.degree}${field}, ${edu.institution}`;
}

/**
 * Build the controlled fact context. `facts` is the flattened, grounded list;
 * `relevantFacts` (below) narrows it per question category for privacy.
 */
export function buildCandidateContext(records: CandidateRecords): CandidateContext {
  const profile = records.profile ?? null;
  const experience = records.experience ?? [];
  const education = records.education ?? [];
  const skills = records.skills ?? [];
  const resume = records.resume ?? null;
  const facts: CandidateFact[] = [];

  if (profile) {
    const add = (key: string, label: string, value: string, source: CandidateFact['source']) => {
      if (value.trim() !== '') facts.push({ key, label, value, source });
    };
    add('name.first', `First name: ${profile.firstName}`, profile.firstName, 'PROFILE');
    add('name.last', `Last name: ${profile.lastName}`, profile.lastName, 'PROFILE');
    if (isMeaningful(profile.preferredName)) {
      add('name.preferred', `Preferred name: ${profile.preferredName}`, profile.preferredName!, 'PROFILE');
    }
    add('email', `Email: ${profile.email}`, profile.email, 'PROFILE');
    if (isMeaningful(profile.phone)) add('phone', `Phone: ${profile.phone}`, profile.phone!, 'PROFILE');
    const loc = locationString(profile);
    if (loc) add('location', `Location: ${loc}`, loc, 'PROFILE');
    if (isMeaningful(profile.linkedinUrl)) {
      add('linkedin', `LinkedIn: ${profile.linkedinUrl}`, profile.linkedinUrl!, 'PROFILE');
    }
    if (isMeaningful(profile.githubUrl)) {
      add('github', `GitHub: ${profile.githubUrl}`, profile.githubUrl!, 'PROFILE');
    }
    if (isMeaningful(profile.portfolioUrl)) {
      add('portfolio', `Portfolio: ${profile.portfolioUrl}`, profile.portfolioUrl!, 'PROFILE');
    }
    if (isMeaningful(profile.websiteUrl)) {
      add('website', `Website: ${profile.websiteUrl}`, profile.websiteUrl!, 'PROFILE');
    }
    if (isMeaningful(profile.summary)) {
      add('summary', `Professional summary: ${profile.summary}`, profile.summary!, 'PROFILE');
    }

    // Work authorization is grounded only when an explicit, meaningful status
    // is stored (the default "OTHER" is NOT a fact).
    if (isMeaningful(profile.workAuthorization)) {
      facts.push({
        key: 'work_authorization',
        label: `Work authorization status: ${profile.workAuthorization}`,
        value: profile.workAuthorization!.trim(),
        source: 'PROFILE',
      });
    }

    // Sponsorship is grounded ONLY on an explicit affirmative. A stored `false`
    // is indistinguishable from the schema default, so it is NOT treated as the
    // fact "I do not require sponsorship" - that would be fabrication.
    if (profile.sponsorshipRequired === true) {
      facts.push({
        key: 'sponsorship',
        label: 'Sponsorship required: Yes (candidate requires employer sponsorship)',
        value: 'Yes, I require sponsorship',
        source: 'PROFILE',
      });
    }

    const min = profile.desiredSalaryMin;
    const max = profile.desiredSalaryMax;
    if (typeof min === 'number' || typeof max === 'number') {
      const value =
        typeof min === 'number' && typeof max === 'number'
          ? `${min} - ${max}`
          : String((max ?? min)!);
      facts.push({ key: 'salary', label: `Desired salary: ${value}`, value, source: 'PROFILE' });
    }

    const prefParts: string[] = [];
    if (isMeaningful(profile.preferredWorkMode) && profile.preferredWorkMode !== 'ANY') {
      prefParts.push(`Work mode: ${profile.preferredWorkMode}`);
    }
    if (profile.willingToRelocate === true) prefParts.push('Willing to relocate: Yes');
    if ((profile.preferredLocations ?? []).length > 0) {
      prefParts.push(`Preferred locations: ${(profile.preferredLocations ?? []).join(', ')}`);
    }
    if (prefParts.length > 0) {
      facts.push({
        key: 'work_preference',
        label: `Work preferences: ${prefParts.join('; ')}`,
        value: prefParts.join('; '),
        source: 'PROFILE',
      });
    }
  }

  experience.forEach((exp, i) => {
    facts.push({
      key: `experience.${i}`,
      label: `Experience: ${experienceLabel(exp)}`,
      value: experienceLabel(exp),
      source: 'EXPERIENCE',
    });
  });

  education.forEach((edu, i) => {
    facts.push({
      key: `education.${i}`,
      label: `Education: ${educationLabel(edu)}`,
      value: educationLabel(edu),
      source: 'EDUCATION',
    });
  });

  if (skills.length > 0) {
    const names = skills.map((s) => s.name).join(', ');
    facts.push({ key: 'skills', label: `Skills: ${names}`, value: names, source: 'SKILL' });
  }

  return { profile, experience, education, skills, resume, facts };
}

/**
 * Fact keys (by prefix) a given category is allowed to see. This is the
 * privacy boundary - unrelated candidate data is excluded from question
 * context (and therefore from any AI prompt).
 */
const CATEGORY_FACT_KEYS: Record<QuestionCategory, string[]> = {
  FIRST_NAME: ['name.first', 'name.preferred'],
  LAST_NAME: ['name.last'],
  FULL_NAME: ['name.first', 'name.last', 'name.preferred'],
  PREFERRED_NAME: ['name.preferred', 'name.first'],
  EMAIL: ['email'],
  PHONE: ['phone'],
  LOCATION: ['location'],
  LINKEDIN: ['linkedin'],
  GITHUB: ['github'],
  PORTFOLIO: ['portfolio'],
  WEBSITE: ['website'],
  WORK_AUTHORIZATION: ['work_authorization'],
  SPONSORSHIP: ['sponsorship'],
  SALARY: ['salary'],
  WORK_PREFERENCE: ['work_preference'],
  EXPERIENCE: ['experience.'],
  YEARS_OF_EXPERIENCE: ['experience.'],
  EDUCATION: ['education.'],
  SKILLS: ['skills'],
  EXPERIENCE_DESCRIPTION: ['experience.', 'education.', 'skills', 'summary'],
  WHY_ROLE: ['experience.', 'education.', 'skills', 'summary'],
  WHY_COMPANY: ['experience.', 'education.', 'skills', 'summary'],
  MOTIVATION: ['experience.', 'education.', 'skills', 'summary'],
  COVER_LETTER: ['experience.', 'education.', 'skills', 'summary'],
  NOTICE_PERIOD: [],
  START_DATE: [],
  OTHER: [],
};

function keyAllowed(key: string, allowed: string[]): boolean {
  return allowed.some((a) => (a.endsWith('.') ? key.startsWith(a) : key === a));
}

/** Only the facts relevant to this category (privacy scoping). */
export function relevantFacts(category: QuestionCategory, ctx: CandidateContext): CandidateFact[] {
  const allowed = CATEGORY_FACT_KEYS[category] ?? [];
  return ctx.facts.filter((f) => keyAllowed(f.key, allowed));
}
