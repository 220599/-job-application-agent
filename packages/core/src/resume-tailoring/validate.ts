/**
 * Phase 11 - deterministic anti-fabrication validation.
 *
 * Every generated claim must be traceable to the candidate facts / source
 * resume content. This module is pure and provider independent: the same
 * output always produces the same verdict. Unsupported claims are returned as
 * structured violations - never silently accepted, never "fixed" by retrying
 * with a more permissive prompt.
 *
 * Checked deterministically:
 *  - employers/titles must correspond to stored/source experience records
 *  - institutions/degrees/fields must correspond to stored/source education
 *  - skills must exist in the candidate's stored skills or source resume text
 *  - dates are never output by the model (its keys are rejected; year claims
 *    in text must exist in the source data)
 *  - numeric metrics must have explicit source support
 *  - certification claims must have explicit source support
 *  - unknown fields (the contract is closed) are rejected
 */
import type {
  TailoredEducationEntry,
  TailoredExperienceEntry,
  TailoredResumeContent,
  TailoringContext,
  TailoringValidationResult,
  TailoringViolation,
  TailoringViolationType,
} from './types';
import {
  TAILORED_CONTENT_KEYS,
  TAILORED_EDUCATION_KEYS,
  TAILORED_EXPERIENCE_KEYS,
} from './types';

// ============================================================================
// Structured output parsing
// ============================================================================

export type TailoredParseError = 'AI_EMPTY_RESPONSE' | 'AI_INVALID_RESPONSE' | 'MODEL_REQUESTED_REVIEW';

export interface TailoredParseResult {
  content: TailoredResumeContent | null;
  error: TailoredParseError | null;
}

const NEEDS_REVIEW_SENTINEL = 'NEEDS_REVIEW';

/**
 * Leniently extract the JSON object from a model response (fences and prose
 * tolerated, structure still strictly validated afterwards). Never guesses at
 * content when parsing fails - a parse failure is a structured failure.
 */
export function parseTailoredContent(raw: string | null | undefined): TailoredParseResult {
  const text = (raw ?? '').trim();
  if (text === '') return { content: null, error: 'AI_EMPTY_RESPONSE' };
  if (text.toUpperCase() === NEEDS_REVIEW_SENTINEL) {
    return { content: null, error: 'MODEL_REQUESTED_REVIEW' };
  }

  // Strip markdown code fences if present.
  let body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    return { content: null, error: 'AI_INVALID_RESPONSE' };
  }
  body = body.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { content: null, error: 'AI_INVALID_RESPONSE' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { content: null, error: 'AI_INVALID_RESPONSE' };
  }
  return { content: parsed as TailoredResumeContent, error: null };
}

// ============================================================================
// Normalization + vocabulary
// ============================================================================

/** Lowercase, strip punctuation, collapse whitespace. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const CORPORATE_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc', 'limited']);

/** Company normalization: case/punctuation insensitive, corporate suffixes dropped. */
function normalizeCompany(value: string): string {
  const tokens = normalize(value)
    .split(' ')
    .filter((t) => t !== '' && !CORPORATE_SUFFIXES.has(t));
  return tokens.join(' ');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary containment in the trusted corpus (lowercased). */
function corpusContains(corpus: string, phrase: string): boolean {
  const p = phrase.trim().toLowerCase();
  if (p === '') return false;
  return new RegExp(`\\b${escapeRegex(p)}\\b`).test(corpus);
}

function equalityOrContainment(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === '' || nb === '') return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

interface ExperienceRecord {
  id?: string;
  company: string;
  title: string;
}

interface EducationRecord {
  id?: string;
  institution: string;
  degree: string;
  fieldOfStudy: string;
}

function sourceExperienceRecords(ctx: TailoringContext): ExperienceRecord[] {
  const records: ExperienceRecord[] = ctx.experience.map((e) => ({
    id: e.id,
    company: e.company,
    title: e.title,
  }));
  const parsed = ctx.source.parsedData?.['experience'];
  if (Array.isArray(parsed)) {
    for (const raw of parsed) {
      if (raw && typeof raw === 'object') {
        const e = raw as Record<string, unknown>;
        if (typeof e['company'] === 'string' && typeof e['title'] === 'string') {
          records.push({ company: e['company'], title: e['title'] });
        }
      }
    }
  }
  return records;
}

function sourceEducationRecords(ctx: TailoringContext): EducationRecord[] {
  const records: EducationRecord[] = ctx.education.map((e) => ({
    id: e.id,
    institution: e.institution,
    degree: e.degree,
    fieldOfStudy: e.fieldOfStudy ?? '',
  }));
  const parsed = ctx.source.parsedData?.['education'];
  if (Array.isArray(parsed)) {
    for (const raw of parsed) {
      if (raw && typeof raw === 'object') {
        const e = raw as Record<string, unknown>;
        if (typeof e['institution'] === 'string' && typeof e['degree'] === 'string') {
          records.push({
            institution: e['institution'],
            degree: e['degree'],
            fieldOfStudy: typeof e['fieldOfStudy'] === 'string' ? e['fieldOfStudy'] : '',
          });
        }
      }
    }
  }
  return records;
}

// ============================================================================
// Text-level claims: dates, metrics, certifications
// ============================================================================

const YEAR_RE = /\b(19|20)\d{2}\b/g;
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;
const CERT_KEYWORD_RE = /\bcertif(?:y|ies|ied|ying|ication|icate|icates)\b/i;
const CERT_CLAIM_RE = /(?:certified|certification|certificate)(?:\s+(?:in|as|of|from))?[\s:]+([\w&+#./' -]{2,60})/i;

function normalizeNumber(raw: string): string {
  // Strip thousands separators only. Leading zeros are preserved so "0100"
  // (e.g. a phone fragment) never legitimizes a "100M records" claim.
  return raw.replace(/[,\.]/g, '');
}

function corpusNumbers(corpus: string): Set<string> {
  const out = new Set<string>();
  for (const m of corpus.matchAll(NUMBER_RE)) {
    out.add(normalizeNumber(m[0]));
  }
  return out;
}

function corpusYears(corpus: string): Set<string> {
  const out = new Set<string>();
  for (const m of corpus.matchAll(YEAR_RE)) out.add(m[0]);
  return out;
}

/**
 * Validate a free-text block (summary, bullet, detail). Every numeric metric,
 * year/date claim, and certification claim must have explicit source support.
 */
function checkText(
  block: string,
  path: string,
  ctx: TailoringContext,
  numbers: Set<string>,
  years: Set<string>,
  violations: TailoringViolation[]
): void {
  const push = (type: TailoringViolationType, value: string) => {
    violations.push({ type, value, path });
  };

  // Year/date claims: the model must never introduce dates the facts lack.
  for (const m of block.matchAll(YEAR_RE)) {
    if (!years.has(m[0])) push('UNSUPPORTED_DATE', m[0]);
  }

  // Certification claims require explicit source support.
  if (CERT_KEYWORD_RE.test(block)) {
    const claim = block.match(CERT_CLAIM_RE)?.[1]?.trim() ?? '';
    const supported = claim !== '' && corpusContains(ctx.corpus, claim);
    if (!supported) {
      push('UNSUPPORTED_CERTIFICATION', claim !== '' ? claim : block.trim().slice(0, 60));
    }
  }

  // Quantitative claims require the exact figure to exist in the source data.
  for (const m of block.matchAll(NUMBER_RE)) {
    const raw = m[0];
    if (YEAR_RE.test(raw)) {
      // Already handled as a date claim above.
      YEAR_RE.lastIndex = 0;
      continue;
    }
    YEAR_RE.lastIndex = 0;
    const normalized = normalizeNumber(raw);
    if (!numbers.has(normalized)) push('UNSUPPORTED_METRIC', raw);
  }
}

// ============================================================================
// Contract validation
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  basePath: string,
  violations: TailoringViolation[]
): void {
  for (const key of Object.keys(obj)) {
    if (!(allowed as readonly string[]).includes(key)) {
      const type = /date/i.test(key)
        ? 'UNSUPPORTED_DATE'
        : /certif/i.test(key)
          ? 'UNSUPPORTED_CERTIFICATION'
          : 'UNSUPPORTED_FIELD';
      violations.push({
        type,
        value: key,
        path: basePath ? `${basePath}.${key}` : key,
      });
    }
  }
}

function validateExperienceEntry(
  entry: unknown,
  index: number,
  ctx: TailoringContext,
  records: ExperienceRecord[],
  numbers: Set<string>,
  years: Set<string>,
  violations: TailoringViolation[]
): void {
  const path = `experience[${index}]`;
  if (!isPlainObject(entry)) {
    violations.push({ type: 'UNSUPPORTED_FIELD', value: path, path });
    return;
  }
  checkUnknownKeys(entry, TAILORED_EXPERIENCE_KEYS, path, violations);

  const company = typeof entry['company'] === 'string' ? entry['company'] : '';
  const title = typeof entry['title'] === 'string' ? entry['title'] : '';
  const experienceId = typeof entry['experienceId'] === 'string' ? entry['experienceId'] : null;

  let candidates = records;
  if (experienceId !== null) {
    const match = records.find((r) => r.id === experienceId);
    if (!match) {
      violations.push({ type: 'UNSUPPORTED_FIELD', value: experienceId, path: `${path}.experienceId` });
      return;
    }
    candidates = [match];
  }

  const companyMatches = candidates.filter((r) => normalizeCompany(r.company) === normalizeCompany(company) && normalizeCompany(company) !== '');
  if (companyMatches.length === 0) {
    violations.push({ type: 'UNSUPPORTED_EMPLOYER', value: company, path: `${path}.company` });
    return;
  }
  const titleMatches = companyMatches.some((r) => normalize(r.title) === normalize(title) && normalize(title) !== '');
  if (!titleMatches) {
    violations.push({ type: 'UNSUPPORTED_TITLE', value: title, path: `${path}.title` });
  }

  const bullets = entry['bullets'];
  if (bullets !== undefined) {
    if (!Array.isArray(bullets)) {
      violations.push({ type: 'UNSUPPORTED_FIELD', value: 'bullets', path: `${path}.bullets` });
    } else {
      bullets.forEach((b, bi) => {
        if (typeof b !== 'string' || b.trim() === '') {
          violations.push({ type: 'UNSUPPORTED_FIELD', value: 'bullets', path: `${path}.bullets[${bi}]` });
        } else {
          checkText(b, `${path}.bullets[${bi}]`, ctx, numbers, years, violations);
        }
      });
    }
  }
}

function validateEducationEntry(
  entry: unknown,
  index: number,
  ctx: TailoringContext,
  records: EducationRecord[],
  numbers: Set<string>,
  years: Set<string>,
  violations: TailoringViolation[]
): void {
  const path = `education[${index}]`;
  if (!isPlainObject(entry)) {
    violations.push({ type: 'UNSUPPORTED_FIELD', value: path, path });
    return;
  }
  checkUnknownKeys(entry, TAILORED_EDUCATION_KEYS, path, violations);

  const institution = typeof entry['institution'] === 'string' ? entry['institution'] : '';
  const degree = typeof entry['degree'] === 'string' ? entry['degree'] : '';
  const fieldOfStudy = typeof entry['fieldOfStudy'] === 'string' ? entry['fieldOfStudy'] : '';
  const educationId = typeof entry['educationId'] === 'string' ? entry['educationId'] : null;

  let candidates = records;
  if (educationId !== null) {
    const match = records.find((r) => r.id === educationId);
    if (!match) {
      violations.push({ type: 'UNSUPPORTED_FIELD', value: educationId, path: `${path}.educationId` });
      return;
    }
    candidates = [match];
  }

  const institutionMatches = candidates.filter(
    (r) => normalize(r.institution) === normalize(institution) && normalize(institution) !== ''
  );
  if (institutionMatches.length === 0) {
    violations.push({ type: 'UNSUPPORTED_INSTITUTION', value: institution, path: `${path}.institution` });
    return;
  }
  const degreeMatches = institutionMatches.filter((r) => equalityOrContainment(r.degree, degree));
  if (degreeMatches.length === 0) {
    violations.push({ type: 'UNSUPPORTED_DEGREE', value: degree, path: `${path}.degree` });
    return;
  }
  if (fieldOfStudy.trim() !== '') {
    const fieldMatches = degreeMatches.some(
      (r) => r.fieldOfStudy.trim() === '' || equalityOrContainment(r.fieldOfStudy, fieldOfStudy)
    );
    if (!fieldMatches) {
      violations.push({ type: 'UNSUPPORTED_FIELD', value: fieldOfStudy, path: `${path}.fieldOfStudy` });
    }
  }

  const details = entry['details'];
  if (details !== undefined) {
    if (!Array.isArray(details)) {
      violations.push({ type: 'UNSUPPORTED_FIELD', value: 'details', path: `${path}.details` });
    } else {
      details.forEach((d, di) => {
        if (typeof d !== 'string' || d.trim() === '') {
          violations.push({ type: 'UNSUPPORTED_FIELD', value: 'details', path: `${path}.details[${di}]` });
        } else {
          checkText(d, `${path}.details[${di}]`, ctx, numbers, years, violations);
        }
      });
    }
  }
}

/**
 * Validate generated content against the candidate facts. Returns structured
 * violations - the caller must NOT create a ResumeVersion when invalid.
 */
export function validateTailoredContent(
  content: unknown,
  ctx: TailoringContext
): TailoringValidationResult {
  const violations: TailoringViolation[] = [];

  if (!isPlainObject(content)) {
    return {
      valid: false,
      violations: [{ type: 'EMPTY_OUTPUT', value: '(no structured content)' }],
    };
  }

  checkUnknownKeys(content, TAILORED_CONTENT_KEYS, '', violations);

  const numbers = corpusNumbers(ctx.corpus);
  const years = corpusYears(ctx.corpus);
  const experienceRecords = sourceExperienceRecords(ctx);
  const educationRecords = sourceEducationRecords(ctx);
  const knownSkillNames = ctx.skills.map((s) => s.name);

  // Skills: only stored skills / source resume content may appear.
  const skills = content['skills'];
  if (skills !== undefined) {
    if (!Array.isArray(skills)) {
      violations.push({ type: 'UNSUPPORTED_FIELD', value: 'skills', path: 'skills' });
    } else {
      skills.forEach((s, i) => {
        if (typeof s !== 'string' || s.trim() === '') {
          violations.push({ type: 'UNSUPPORTED_FIELD', value: 'skills', path: `skills[${i}]` });
          return;
        }
        const known = knownSkillNames.some(
          (name) => normalize(name) === normalize(s) || corpusContains(ctx.corpus, s)
        );
        if (!known) {
          violations.push({ type: 'UNSUPPORTED_SKILL', value: s, path: `skills[${i}]` });
        }
      });
    }
  }

  // Summary: free text, but every quantitative/date/certification claim must
  // be supported by the source data.
  const summary = content['summary'];
  if (summary !== undefined) {
    if (typeof summary !== 'string' || summary.trim() === '') {
      violations.push({ type: 'UNSUPPORTED_FIELD', value: 'summary', path: 'summary' });
    } else {
      checkText(summary, 'summary', ctx, numbers, years, violations);
    }
  }

  // Experience / education entries.
  const experience = content['experience'];
  if (experience !== undefined) {
    if (!Array.isArray(experience)) {
      violations.push({ type: 'UNSUPPORTED_FIELD', value: 'experience', path: 'experience' });
    } else {
      experience.forEach((e, i) =>
        validateExperienceEntry(e, i, ctx, experienceRecords, numbers, years, violations)
      );
    }
  }

  const education = content['education'];
  if (education !== undefined) {
    if (!Array.isArray(education)) {
      violations.push({ type: 'UNSUPPORTED_FIELD', value: 'education', path: 'education' });
    } else {
      education.forEach((e, i) =>
        validateEducationEntry(e, i, ctx, educationRecords, numbers, years, violations)
      );
    }
  }

  // A tailored resume with no content at all is not a usable result.
  const hasContent =
    (typeof summary === 'string' && summary.trim() !== '') ||
    (Array.isArray(skills) && skills.length > 0) ||
    (Array.isArray(experience) && experience.length > 0) ||
    (Array.isArray(education) && education.length > 0);
  if (!hasContent && violations.length === 0) {
    violations.push({ type: 'EMPTY_OUTPUT', value: '(empty tailored resume)' });
  }

  return { valid: violations.length === 0, violations };
}

/** Narrow a validated payload to the typed content contract. */
export function toTailoredContent(content: TailoredResumeContent): TailoredResumeContent {
  return {
    ...(typeof content.summary === 'string' ? { summary: content.summary } : {}),
    ...(Array.isArray(content.skills) ? { skills: [...content.skills] } : {}),
    ...(Array.isArray(content.experience)
      ? {
          experience: content.experience.map((e: TailoredExperienceEntry) => ({
            ...(e.experienceId ? { experienceId: e.experienceId } : {}),
            company: e.company,
            title: e.title,
            bullets: [...e.bullets],
          })),
        }
      : {}),
    ...(Array.isArray(content.education)
      ? {
          education: content.education.map((e: TailoredEducationEntry) => ({
            ...(e.educationId ? { educationId: e.educationId } : {}),
            institution: e.institution,
            degree: e.degree,
            fieldOfStudy: e.fieldOfStudy,
            ...(Array.isArray(e.details) ? { details: [...e.details] } : {}),
          })),
        }
      : {}),
  };
}
