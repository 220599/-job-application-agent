/**
 * Phase 10 - grounded AI answer generation (via the @jaa/ai abstraction).
 *
 * The prompt is grounded in the candidate facts and job context and carries
 * explicit anti-fabrication instructions. Only question-relevant facts are
 * sent (privacy). The model is asked to answer within a length budget and to
 * return NEEDS_REVIEW when facts are insufficient; truncation is only a final
 * safety measure. Failures never masquerade as success.
 */
import { AiError, type AiProvider } from '@jaa/ai';
import type {
  AnswerDraft,
  CandidateContext,
  CandidateFact,
  JobContext,
  QuestionCategory,
  QuestionInput,
} from './types';
import { relevantFacts } from './facts';

export type LengthKind = 'short' | 'medium' | 'long';

interface LengthBudget {
  words: number;
  chars: number;
}

export const LENGTH_BUDGETS: Record<LengthKind, LengthBudget> = {
  short: { words: 30, chars: 220 },
  medium: { words: 130, chars: 900 },
  long: { words: 400, chars: 2600 },
};

const CATEGORY_LENGTH: Record<QuestionCategory, LengthKind> = {
  COVER_LETTER: 'long',
  EXPERIENCE_DESCRIPTION: 'long',
  WHY_COMPANY: 'medium',
  WHY_ROLE: 'medium',
  MOTIVATION: 'medium',
  // Deterministic categories are short by nature (not used for prompting).
  FIRST_NAME: 'short',
  LAST_NAME: 'short',
  FULL_NAME: 'short',
  PREFERRED_NAME: 'short',
  EMAIL: 'short',
  PHONE: 'short',
  LOCATION: 'short',
  LINKEDIN: 'short',
  GITHUB: 'short',
  PORTFOLIO: 'short',
  WEBSITE: 'short',
  WORK_AUTHORIZATION: 'short',
  SPONSORSHIP: 'short',
  EXPERIENCE: 'medium',
  EDUCATION: 'medium',
  SKILLS: 'medium',
  YEARS_OF_EXPERIENCE: 'short',
  SALARY: 'short',
  NOTICE_PERIOD: 'short',
  START_DATE: 'short',
  WORK_PREFERENCE: 'short',
  OTHER: 'medium',
};

export function lengthKindFor(category: QuestionCategory): LengthKind {
  return CATEGORY_LENGTH[category] ?? 'medium';
}

const CONF_MEDIUM = 0.6;
const CONF_LOW = 0.4;

/** Sentinel the model is instructed to emit when facts are insufficient. */
export const NEEDS_REVIEW_SENTINEL = 'NEEDS_REVIEW';

/**
 * Whether the supplied facts are sufficient to attempt an answer for this
 * category without risking fabrication. Insufficient -> needsReview, no call.
 */
export function hasSufficientFacts(
  category: QuestionCategory,
  ctx: CandidateContext,
  job?: JobContext | null
): boolean {
  const hasExperience = ctx.experience.length > 0;
  const hasSkills = ctx.skills.length > 0;
  const hasSummary = Boolean(ctx.profile?.summary && ctx.profile.summary.trim() !== '');
  const hasCandidateSubstance = hasExperience || hasSkills || hasSummary;
  const hasJob = Boolean(job && (job.company || job.title || job.description));

  switch (category) {
    case 'EXPERIENCE_DESCRIPTION':
      return hasExperience || hasSkills || hasSummary;
    case 'MOTIVATION':
      return hasExperience || hasSkills || hasSummary;
    case 'WHY_ROLE':
    case 'WHY_COMPANY':
    case 'COVER_LETTER':
      return hasJob && hasCandidateSubstance;
    default:
      return hasCandidateSubstance;
  }
}

/** Compose the grounded prompt with anti-fabrication and length guidance. */
export function buildAiPrompt(
  question: QuestionInput,
  category: QuestionCategory,
  facts: CandidateFact[],
  job?: JobContext | null
): string {
  const length = LENGTH_BUDGETS[lengthKindFor(category)];

  const factLines =
    facts.length > 0
      ? facts.map((f) => `- ${f.label}`).join('\n')
      : '- (no candidate facts supplied)';

  const jobLines: string[] = [];
  if (job?.company) jobLines.push(`Company: ${job.company}`);
  if (job?.title) jobLines.push(`Title: ${job.title}`);
  if (job?.description) jobLines.push(`Description: ${truncateWords(job.description, 300)}`);
  if (job?.requirements?.length) jobLines.push(`Requirements: ${job.requirements.join('; ')}`);
  if (job?.responsibilities?.length)
    jobLines.push(`Responsibilities: ${job.responsibilities.join('; ')}`);
  if (job?.skills?.length) jobLines.push(`Skills: ${job.skills.join(', ')}`);
  const jobBlock =
    jobLines.length > 0 ? jobLines.join('\n') : '(no job context available)';

  return [
    'You are helping a job candidate answer an application question truthfully.',
    '',
    'STRICT GROUNDING RULES:',
    '- Use ONLY the candidate facts provided below. Do not invent or fabricate any information.',
    '- Do not invent employers, projects, technologies, education, or certifications.',
    '- Do not invent years of experience, work authorization, sponsorship, or salary information.',
    '- Do not claim experience that is absent from the supplied facts.',
    '- You may rephrase and organize the facts and tailor wording to the job context, but never add facts.',
    '- The job context is for tailoring wording only. Do NOT claim you have experience just because the job asks for it.',
    '- If the supplied facts are insufficient to answer truthfully, reply with exactly: NEEDS_REVIEW',
    '',
    `LENGTH: This is a ${lengthKindFor(category)} field. Keep the answer under ${length.words} words.`,
    '',
    'CANDIDATE FACTS (the only source of truth):',
    factLines,
    '',
    'JOB CONTEXT (tailor wording only - do NOT fabricate experience):',
    jobBlock,
    '',
    `APPLICATION QUESTION: ${question.label}`,
    '',
    'ANSWER:',
  ].join('\n');
}

/** Clean word-boundary truncation (final safety measure only). */
export function truncateWords(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const slice = t.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}...`;
}

function failureDraft(
  category: QuestionCategory,
  facts: CandidateFact[],
  errorCode: string,
  reasoning: string,
  reviewReason: string
): AnswerDraft {
  return {
    questionId: '',
    category,
    strategy: 'AI',
    answer: null,
    source: 'AI',
    confidence: CONF_LOW,
    groundedFacts: facts.map((f) => f.label),
    needsReview: true,
    reviewReason,
    reasoning,
    errorCode,
  };
}

/**
 * Generate an answer for a narrative category via the AI provider. Returns a
 * draft with provenance. Never marks a failed generation as success.
 */
export async function aiAnswer(
  category: QuestionCategory,
  question: QuestionInput,
  ctx: CandidateContext,
  job: JobContext | null | undefined,
  provider: AiProvider | null | undefined
): Promise<AnswerDraft> {
  const facts = relevantFacts(category, ctx);

  // Insufficient facts -> review, never fabricate (and never call the model).
  if (!hasSufficientFacts(category, ctx, job)) {
    return {
      questionId: '',
      category,
      strategy: 'AI',
      answer: null,
      source: 'AI',
      confidence: CONF_LOW,
      groundedFacts: facts.map((f) => f.label),
      needsReview: true,
      reviewReason: 'INSUFFICIENT_FACTS',
      reasoning: 'Insufficient grounded facts to answer without fabricating.',
      errorCode: null,
    };
  }

  // No provider configured -> structured failure, needs review.
  if (!provider) {
    return failureDraft(
      category,
      facts,
      'AI_PROVIDER_UNAVAILABLE',
      'No AI provider is configured for generation.',
      'AI_PROVIDER_UNAVAILABLE'
    );
  }

  const prompt = buildAiPrompt(question, category, facts, job);

  let raw: string;
  try {
    const result = await provider.generate({ prompt, options: { temperature: 0.4 } });
    raw = result.text ?? '';
  } catch (err) {
    const code = err instanceof AiError ? err.code : 'AI_REQUEST_FAILED';
    return failureDraft(
      category,
      facts,
      code,
      'AI generation failed.',
      code
    );
  }

  const text = raw.trim();
  if (text === '') {
    return failureDraft(
      category,
      facts,
      'AI_EMPTY_RESPONSE',
      'AI returned an empty response.',
      'AI_EMPTY_RESPONSE'
    );
  }

  if (text.toUpperCase() === NEEDS_REVIEW_SENTINEL) {
    return {
      questionId: '',
      category,
      strategy: 'AI',
      answer: null,
      source: 'AI',
      confidence: CONF_LOW,
      groundedFacts: facts.map((f) => f.label),
      needsReview: true,
      reviewReason: 'MODEL_REQUESTED_REVIEW',
      reasoning: 'Model reported that the supplied facts were insufficient.',
      errorCode: null,
    };
  }

  const budget = LENGTH_BUDGETS[lengthKindFor(category)];
  const answer = truncateWords(text, budget.chars);
  const confidence = facts.length > 1 ? CONF_MEDIUM : CONF_LOW;

  return {
    questionId: '',
    category,
    strategy: 'AI',
    answer,
    source: 'AI',
    confidence,
    groundedFacts: facts.map((f) => f.label),
    needsReview: true, // AI answers always require human review (never auto-approved)
    reviewReason: 'AI_GENERATED',
    reasoning: `AI-generated from ${facts.length} grounded fact(s); requires human review.`,
    errorCode: null,
  };
}
