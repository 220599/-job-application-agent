/**
 * Phase 10 - deterministic answers (no LLM).
 *
 * Direct candidate facts are answered exactly from stored data with source +
 * provenance. Missing or ambiguous facts are NEVER invented - they produce
 * `needsReview` with no answer. Sponsorship and work authorization use extra
 * strict grounding.
 */
import type {
  AnswerDraft,
  CandidateContext,
  CandidateFact,
  QuestionCategory,
  QuestionInput,
} from './types';
import { computeYearsOfExperience } from './facts';

const CONF_HIGH = 0.95;
const CONF_MEDIUM = 0.8;
const CONF_VLOW = 0.1;

const YES_AUTH_RE =
  /citizen|national|green[_\s-]?card|permanent|resident|authorized|ead|work[_\s-]?permit|h-?1b|l-?1|o-?1|tn\b|opt\b|cpt\b|visa|\bpr\b|authorized[_\s-]?to[_\s-]?work/;
const NOT_AUTH_RE =
  /not[_\s-]?authorized|unauthorized|no[_\s-]?visa|require[_\s-]?sponsor|need[_\s-]?sponsor|not[_\s-]?eligible|ineligible|no[_\s-]?work/;

function factBy(ctx: CandidateContext, key: string): CandidateFact | undefined {
  return ctx.facts.find((f) => f.key === key);
}

function factsByPrefix(ctx: CandidateContext, prefix: string): CandidateFact[] {
  return ctx.facts.filter((f) => f.key.startsWith(prefix));
}

function usedSource(facts: CandidateFact[]): AnswerDraft['source'] {
  return facts.length > 0 ? facts[0].source : 'SYSTEM';
}

function missing(
  category: QuestionCategory,
  reason: string = 'MISSING_FACT'
): AnswerDraft {
  return {
    questionId: '',
    category,
    strategy: 'DETERMINISTIC',
    answer: null,
    source: 'SYSTEM',
    confidence: CONF_VLOW,
    groundedFacts: [],
    needsReview: true,
    reviewReason: reason,
    reasoning: 'No grounded candidate fact is available for this question.',
    errorCode: null,
  };
}

function resolved(
  category: QuestionCategory,
  answer: string,
  facts: CandidateFact[],
  confidence: number,
  needsReview: boolean,
  reviewReason?: string
): AnswerDraft {
  return {
    questionId: '',
    category,
    strategy: 'DETERMINISTIC',
    answer,
    source: usedSource(facts),
    confidence,
    groundedFacts: facts.map((f) => f.label),
    needsReview,
    reviewReason: reviewReason ?? null,
    reasoning: facts.length > 0 ? `Grounded in ${facts.length} stored fact(s).` : null,
    errorCode: null,
  };
}

/** Choose a Yes/No option value when the field is a binary control. */
function pickYesNo(question: QuestionInput, yes: boolean): string {
  const target = yes ? 'yes' : 'no';
  const opts = question.options ?? [];
  const match = opts.find(
    (o) =>
      (o.value ?? '').trim().toLowerCase() === target ||
      (o.label ?? '').trim().toLowerCase() === target
  );
  return match ? match.value : yes ? 'Yes' : 'No';
}

function isBinary(question: QuestionInput): boolean {
  const t = (question.fieldType ?? '').toUpperCase();
  return t === 'RADIO' || t === 'CHECKBOX' || t === 'SELECT';
}

function deriveAuthorized(value: string): boolean | undefined {
  const v = value.toLowerCase();
  if (NOT_AUTH_RE.test(v)) return false;
  if (YES_AUTH_RE.test(v)) return true;
  return undefined;
}

/**
 * Produce a deterministic answer for a direct-fact category. Returns a full
 * draft (with `answer: null` + `needsReview` when the fact is missing).
 */
export function deterministicAnswer(
  category: QuestionCategory,
  question: QuestionInput,
  ctx: CandidateContext
): AnswerDraft {
  switch (category) {
    case 'FIRST_NAME': {
      const f = factBy(ctx, 'name.first');
      return f ? resolved(category, f.value, [f], CONF_HIGH, false) : missing(category);
    }
    case 'LAST_NAME': {
      const f = factBy(ctx, 'name.last');
      return f ? resolved(category, f.value, [f], CONF_HIGH, false) : missing(category);
    }
    case 'PREFERRED_NAME': {
      const pref = factBy(ctx, 'name.preferred');
      const first = factBy(ctx, 'name.first');
      const f = pref ?? first;
      return f ? resolved(category, f.value, [f], CONF_HIGH, false) : missing(category);
    }
    case 'FULL_NAME': {
      const first = factBy(ctx, 'name.first');
      const last = factBy(ctx, 'name.last');
      if (first && last) {
        return resolved(category, `${first.value} ${last.value}`, [first, last], CONF_HIGH, false);
      }
      return missing(category);
    }
    case 'EMAIL': {
      const f = factBy(ctx, 'email');
      return f ? resolved(category, f.value, [f], CONF_HIGH, false) : missing(category);
    }
    case 'PHONE': {
      const f = factBy(ctx, 'phone');
      return f ? resolved(category, f.value, [f], CONF_HIGH, false) : missing(category);
    }
    case 'LOCATION': {
      const f = factBy(ctx, 'location');
      return f ? resolved(category, f.value, [f], CONF_HIGH, false) : missing(category);
    }
    case 'LINKEDIN': {
      const f = factBy(ctx, 'linkedin');
      return f ? resolved(category, f.value, [f], CONF_HIGH, false) : missing(category);
    }
    case 'GITHUB': {
      const f = factBy(ctx, 'github');
      return f ? resolved(category, f.value, [f], CONF_HIGH, false) : missing(category);
    }
    case 'PORTFOLIO': {
      const f = factBy(ctx, 'portfolio');
      return f ? resolved(category, f.value, [f], CONF_HIGH, false) : missing(category);
    }
    case 'WEBSITE': {
      const f = factBy(ctx, 'website');
      return f ? resolved(category, f.value, [f], CONF_HIGH, false) : missing(category);
    }

    case 'WORK_AUTHORIZATION': {
      const f = factBy(ctx, 'work_authorization');
      if (!f) return missing(category, 'MISSING_FACT');
      const authorized = deriveAuthorized(f.value);
      if (isBinary(question)) {
        if (authorized === undefined) {
          return {
            ...missing(category, 'AMBIGUOUS_WORK_AUTHORIZATION'),
            groundedFacts: [f.label],
            source: 'PROFILE',
          };
        }
        return resolved(category, pickYesNo(question, authorized), [f], CONF_HIGH, false);
      }
      return resolved(category, `Work authorization status: ${f.value}`, [f], CONF_HIGH, false);
    }

    case 'SPONSORSHIP': {
      // Strict grounding: only an explicit affirmative is a fact. A stored
      // `false` is the schema default and is NOT treated as "I do not require
      // sponsorship" - that would be fabrication.
      const f = factBy(ctx, 'sponsorship');
      if (!f) return missing(category, 'MISSING_FACT');
      const answer = isBinary(question) ? pickYesNo(question, true) : f.value;
      return resolved(category, answer, [f], CONF_MEDIUM, false);
    }

    case 'EXPERIENCE': {
      const expFacts = factsByPrefix(ctx, 'experience.');
      if (expFacts.length === 0) return missing(category);
      const answer = expFacts.map((f) => f.value).join('; ');
      return resolved(category, answer, expFacts, CONF_MEDIUM, false);
    }

    case 'EDUCATION': {
      const eduFacts = factsByPrefix(ctx, 'education.');
      if (eduFacts.length === 0) return missing(category);
      const answer = eduFacts.map((f) => f.value).join('; ');
      return resolved(category, answer, eduFacts, CONF_MEDIUM, false);
    }

    case 'SKILLS': {
      const f = factBy(ctx, 'skills');
      return f ? resolved(category, f.value, [f], CONF_MEDIUM, false) : missing(category);
    }

    case 'YEARS_OF_EXPERIENCE': {
      const years = computeYearsOfExperience(ctx.experience);
      if (years === null) return missing(category);
      const expFacts = factsByPrefix(ctx, 'experience.');
      // A span of exactly N calendar years is 365N + L days (L = leap days),
      // which is up to one day under N * 365.25 - flooring the raw value would
      // understate it as N-1. Tolerate one day of drift before flooring so
      // exact years are never understated.
      const wholeYears = Math.floor(years + 1 / 365.25);
      return resolved(category, String(wholeYears), expFacts, CONF_MEDIUM, false);
    }

    case 'SALARY': {
      const f = factBy(ctx, 'salary');
      // Conservative: salary is negotiation-sensitive and range-vs-single is
      // ambiguous, so it always needs human review even when grounded.
      return f
        ? resolved(category, f.value, [f], CONF_MEDIUM, true, 'SALARY_IS_SENSITIVE')
        : missing(category);
    }

    case 'WORK_PREFERENCE': {
      const f = factBy(ctx, 'work_preference');
      return f ? resolved(category, f.value, [f], CONF_MEDIUM, false) : missing(category);
    }

    case 'NOTICE_PERIOD':
      return missing(category, 'MISSING_FACT');
    case 'START_DATE':
      return missing(category, 'MISSING_FACT');

    default:
      return missing(category, 'UNSUPPORTED_QUESTION');
  }
}
