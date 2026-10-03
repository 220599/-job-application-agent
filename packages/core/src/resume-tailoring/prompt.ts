/**
 * Phase 11 - grounded tailoring prompt (via the @jaa/ai abstraction).
 *
 * The prompt is scoped: it contains only resume-relevant candidate facts, the
 * source resume content, and the job context. It carries explicit
 * anti-fabrication instructions and requests a STRUCTURED JSON response that
 * the deterministic validator can check against the candidate facts. The job
 * context only decides what to emphasize - it never licenses new facts.
 */
import type { TailorJobContext, TailoringContext } from './types';

/** Prompt version recorded in provenance (safe metadata). */
export const TAILORING_PROMPT_VERSION = 'v1';

/** Sentinel the model can emit when the facts cannot support a tailored resume. */
export const TAILORING_NEEDS_REVIEW_SENTINEL = 'NEEDS_REVIEW';

function truncateChars(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const slice = t.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}...`;
}

function jobBlock(job: TailorJobContext | null | undefined): string {
  const lines: string[] = [];
  if (job?.company) lines.push(`Company: ${job.company}`);
  if (job?.title) lines.push(`Title: ${job.title}`);
  if (job?.location) lines.push(`Location: ${job.location}`);
  if (job?.employmentType) lines.push(`Employment type: ${job.employmentType}`);
  if (job?.workMode) lines.push(`Work mode: ${job.workMode}`);
  if (job?.description) lines.push(`Description: ${truncateChars(job.description, 3000)}`);
  if (job?.requirements?.length) {
    lines.push(`Requirements:\n${job.requirements.map((r) => `- ${r}`).join('\n')}`);
  }
  if (job?.responsibilities?.length) {
    lines.push(`Responsibilities:\n${job.responsibilities.map((r) => `- ${r}`).join('\n')}`);
  }
  if (job?.skills?.length) lines.push(`Skills: ${job.skills.join(', ')}`);
  return lines.length > 0 ? lines.join('\n') : '(no job context available)';
}

function candidateBlock(ctx: TailoringContext): string {
  const lines: string[] = [];
  const p = ctx.profile;
  if (p) {
    const name = [p.preferredName || p.firstName, p.lastName].filter(Boolean).join(' ');
    lines.push(`Name: ${name}`);
    lines.push(`Email: ${p.email}`);
    if (p.phone) lines.push(`Phone: ${p.phone}`);
    const loc = p.location || [p.city, p.state, p.country].filter(Boolean).join(', ');
    if (loc) lines.push(`Location: ${loc}`);
    if (p.linkedinUrl) lines.push(`LinkedIn: ${p.linkedinUrl}`);
    if (p.githubUrl) lines.push(`GitHub: ${p.githubUrl}`);
    if (p.portfolioUrl) lines.push(`Portfolio: ${p.portfolioUrl}`);
    if (p.websiteUrl) lines.push(`Website: ${p.websiteUrl}`);
    if (p.summary) lines.push(`Current summary: ${p.summary}`);
    if (p.desiredRoles?.length) lines.push(`Desired roles: ${p.desiredRoles.join(', ')}`);
    if (p.workAuthorization && p.workAuthorization.toUpperCase() !== 'OTHER') {
      lines.push(`Work authorization: ${p.workAuthorization}`);
    }
  }
  if (ctx.experience.length > 0) {
    lines.push('Experience (facts - use verbatim for company/title/dates):');
    ctx.experience.forEach((e, i) => {
      const start = e.startDate instanceof Date ? e.startDate.toISOString().slice(0, 7) : String(e.startDate ?? '').slice(0, 7);
      const end = e.isCurrent
        ? 'Present'
        : e.endDate
          ? (e.endDate instanceof Date ? e.endDate.toISOString().slice(0, 7) : String(e.endDate).slice(0, 7))
          : 'Present';
      lines.push(`[${i + 1}] ${e.title} at ${e.company} (${start} - ${end})${e.employmentType ? ` [${e.employmentType}]` : ''}`);
      if (e.description) lines.push(`    Current description: ${truncateChars(e.description, 1200)}`);
    });
  }
  if (ctx.education.length > 0) {
    lines.push('Education (facts - use verbatim for institution/degree/field):');
    ctx.education.forEach((e, i) => {
      const field = e.fieldOfStudy ? ` in ${e.fieldOfStudy}` : '';
      lines.push(`[${i + 1}] ${e.degree}${field}, ${e.institution}`);
      if (e.description) lines.push(`    Current details: ${truncateChars(e.description, 800)}`);
    });
  }
  if (ctx.skills.length > 0) {
    lines.push(`Skills (the ONLY skills that may appear in the output): ${ctx.skills.map((s) => s.name).join(', ')}`);
  }
  if (ctx.yearsOfExperience !== null) {
    lines.push(`Total experience: ${Math.floor(ctx.yearsOfExperience)} years (computed from stored dates)`);
  }
  if (ctx.source.extractedText && ctx.source.extractedText.trim() !== '') {
    lines.push(`Source resume text (may be rephrased, never extended):\n${truncateChars(ctx.source.extractedText, 4000)}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(no candidate facts supplied)';
}

/**
 * Compose the grounded tailoring prompt: scoped candidate facts + job context
 * + the strict structured output contract.
 */
export function buildTailoringPrompt(ctx: TailoringContext, job: TailorJobContext | null | undefined): string {
  return [
    'You are tailoring a candidate resume for a specific job opening.',
    '',
    'STRICT GROUNDING RULES:',
    '- Use ONLY the candidate facts provided below. Do not invent or fabricate any information.',
    '- Do not invent employers, job titles, degrees, certifications, or projects.',
    '- Do not invent technologies, programming languages, or skills. Only skills from the facts may appear.',
    '- Do not invent years of experience, responsibilities, achievements, metrics, awards, or locations.',
    '- Do not invent or alter any employment or education dates. Never output dates at all.',
    '- Do not add quantitative claims (numbers, percentages, amounts) unless the exact figure appears in the facts.',
    '- The job context is for emphasis and keyword alignment only. Do NOT claim experience the candidate lacks.',
    '- Missing skills must remain missing. Do not add a skill just because the job asks for it.',
    '- You MAY reorder and emphasize existing skills, rewrite bullets and the summary using existing facts,',
    '  improve wording and keyword alignment, reorganize sections, reorder bullets, and remove less relevant content.',
    '- If the facts cannot support a truthful tailored resume, reply with exactly: NEEDS_REVIEW',
    '',
    'OUTPUT FORMAT: reply with a single JSON object (no markdown, no prose) of the shape:',
    '{',
    '  "summary": string,',
    '  "skills": string[],',
    '  "experience": [{ "experienceId": string, "company": string, "title": string, "bullets": string[] }],',
    '  "education": [{ "educationId": string, "institution": string, "degree": string, "fieldOfStudy": string, "details": string[] }]',
    '}',
    '- "experienceId"/"educationId" reference the numbered facts above when applicable.',
    '- "company", "title", "institution", "degree", and "fieldOfStudy" must be copied verbatim from the facts.',
    '- Each experience entry needs at least one bullet. Keep bullets concise and achievement-focused.',
    '- "skills" may only contain skills from the facts, reordered/emphasized as relevant to the job.',
    '- Omit sections you cannot support; never pad with invented content.',
    '',
    'CANDIDATE FACTS (the only source of truth):',
    candidateBlock(ctx),
    '',
    'JOB CONTEXT (emphasis and keywords only - do NOT fabricate experience):',
    jobBlock(job),
    '',
    'TAILORED RESUME JSON:',
  ].join('\n');
}
