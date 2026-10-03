/**
 * Phase 10 - deterministic question classification.
 *
 * Runs BEFORE any LLM is invoked. Pure, side-effect free, and provider
 * independent: it classifies a question from its label text (and, when the ATS
 * adapter recorded one, a normalized `semantic` tag stored on the question's
 * locator). No network, no model calls, no nondeterminism.
 */
import type { QuestionCategory, QuestionInput, AnswerStrategy } from './types';

export interface QuestionClassification {
  category: QuestionCategory;
  strategy: AnswerStrategy;
  /** What drove the decision (for provenance / debugging). */
  matchedBy: 'semantic' | 'fieldType' | 'label' | 'default';
  /** The rule or tag that matched, when applicable. */
  matchedRule?: string | null;
}

/**
 * Normalized `semantic` tags recorded by the ATS adapters on
 * ApplicationQuestion.locator.attributes.semantic. Both Greenhouse and Lever
 * emit this shared vocabulary; unmapped tags fall through to label matching.
 */
const SEMANTIC_TO_CATEGORY: Record<string, QuestionCategory> = {
  first_name: 'FIRST_NAME',
  last_name: 'LAST_NAME',
  full_name: 'FULL_NAME',
  preferred_name: 'PREFERRED_NAME',
  email: 'EMAIL',
  phone: 'PHONE',
  location: 'LOCATION',
  linkedin: 'LINKEDIN',
  github: 'GITHUB',
  portfolio: 'PORTFOLIO',
  website: 'WEBSITE',
  work_authorization: 'WORK_AUTHORIZATION',
  sponsorship: 'SPONSORSHIP',
  cover_letter: 'COVER_LETTER',
};

/**
 * Ordered label rules. First match wins - more specific phrases come first,
 * so a specific rule must always be listed before any generic rule that would
 * also match the same label (e.g. "Motivation letter" is a COVER_LETTER, not a
 * MOTIVATION question).
 */
const LABEL_RULES: { category: QuestionCategory; rule: string; re: RegExp }[] = [
  // Generative / narrative intent first (they mention "experience", "work"...)
  {
    category: 'WHY_COMPANY',
    rule: 'why-work-here',
    re: /why\s+(?:do\s+you\s+)?want\s+to\s+work\s+(?:here|at|for|with)|why\s+(?:do\s+you\s+)?want\s+to\s+(?:work\s+for|join)\s+(?:us|this|our)|why\s+(?:(?:our|this|the|your)\s+)?company\b|why\s+(?:do\s+you\s+)?want\s+to\s+work\s+for\s+us|why\s+are\s+you\s+interested\s+in\s+(?:this|our)\s+(?:company|organization|employer)|what\s+(?:do\s+you\s+)?know\s+about\s+(?:us|our\s+company|this\s+company)|why\s+us\b/,
  },
  {
    category: 'WHY_ROLE',
    rule: 'why-this-role',
    re: /why\s+(?:(?:this|the)\s+)?(?:role|position|job|opportunity)\b|why\s+are\s+you\s+interested\s+in\s+(?:this|the)\s+(?:role|position|job|opportunity)|why\s+do\s+you\s+want\s+(?:this|the)\s+(?:role|position|job)|why\s+(?:do\s+you\s+)?want\s+(?:to\s+)?(?:do|fill)\s+this|what\s+interests\s+you\s+about\s+(?:this|the)\s+(?:role|position|job)/,
  },
  // COVER_LETTER before MOTIVATION: "motivation letter" / "letter of
  // motivation" are cover letters and must not fall into the generic
  // "motivat" keyword.
  {
    category: 'COVER_LETTER',
    rule: 'cover-letter',
    re: /cover\s*[\s_-]*letter|letter\s+of\s+motivation|motivation\s+letter/,
  },
  {
    category: 'MOTIVATION',
    rule: 'motivation',
    re: /motivat|what\s+drives\s+you|career\s+goal|where\s+do\s+you\s+see\s+yourself/,
  },
  {
    category: 'EXPERIENCE_DESCRIPTION',
    rule: 'experience-description',
    re: /describe\s+(?:your\s+)?(?:relevant\s+|work\s+|professional\s+)?experience|tell\s+(?:us|me)\s+about\s+(?:your\s+)?(?:relevant\s+|work\s+|professional\s+)?experience|experience\s+description|walk\s+(?:us|me)\s+through\s+(?:your\s+)?experience|summarize\s+your\s+(?:work\s+)?experience|tell\s+(?:us|me)\s+about\s+yourself|describe\s+yourself|(?:^|\b)about\s+you\b|briefly\s+introduce|introduce\s+yourself/,
  },
  {
    category: 'YEARS_OF_EXPERIENCE',
    rule: 'years-of-experience',
    re: /years?\s+of\s+(?:relevant\s+|work\s+|professional\s+)?experience|how\s+many\s+years|total\s+years|experience\s*\(?\s*years?\)?|relevant\s+years|years?\s+in\s+(?:the\s+)?(?:industry|field|role)/,
  },
  // Work authorization phrasing wins over "sponsorship" wording.
  {
    category: 'WORK_AUTHORIZATION',
    rule: 'work-authorization',
    re: /authorized\s+to\s+work|legally\s+authorized|right\s+to\s+work|work\s+authorization|eligible\s+to\s+work|permission\s+to\s+work|legally\s+eligible|authorized\s+for\s+employment/,
  },
  {
    category: 'SPONSORSHIP',
    rule: 'sponsorship',
    re: /sponsor|visa\s+(?:status|sponsorship|require)|immigration\s+(?:status|sponsor)|require\s+(?:a\s+)?visa|need\s+(?:a\s+)?visa/,
  },
  // Identity / contact. PREFERRED_NAME before FIRST_NAME so
  // "preferred first name" resolves to the more specific category.
  {
    category: 'PREFERRED_NAME',
    rule: 'preferred-name',
    re: /preferred\s*(?:first\s*)?name|nick\s*name|what\s+do\s+you\s+go\s+by/,
  },
  {
    category: 'FIRST_NAME',
    rule: 'first-name',
    re: /first\s*name|given\s*name|forename/,
  },
  {
    category: 'LAST_NAME',
    rule: 'last-name',
    re: /last\s*name|family\s*name|surname|sur\s*name/,
  },
  {
    category: 'FULL_NAME',
    rule: 'full-name',
    re: /full\s*name|applicant'?s?\s*name|your\s+name|^name\b|^\s*name\s*[?:]?\s*$/,
  },
  {
    category: 'EMAIL',
    rule: 'email',
    re: /e-?mail|email\s+address/,
  },
  {
    category: 'PHONE',
    rule: 'phone',
    re: /phone|telephone|mobile|cell|contact\s+number/,
  },
  {
    category: 'LINKEDIN',
    rule: 'linkedin',
    re: /linked\s*in/,
  },
  {
    category: 'GITHUB',
    rule: 'github',
    re: /git\s*hub/,
  },
  {
    category: 'PORTFOLIO',
    rule: 'portfolio',
    re: /portfolio|personal\s+(?:web)?site|web[\s_-]*site|online\s+portfolio/,
  },
  {
    category: 'WEBSITE',
    rule: 'website',
    re: /website|personal\s+url|home\s*page/,
  },
  // Work preferences before LOCATION: "preferred location" / "work location"
  // resolve to the more specific WORK_PREFERENCE category.
  {
    category: 'WORK_PREFERENCE',
    rule: 'work-preference',
    re: /work\s+(?:mode|style|preference|location)|remote|hybrid|on-?site|in-?office|willing\s+to\s+relocate|relocation|work\s+from\s+home|open\s+to\s+remote|preferred\s+(?:work|location)/,
  },
  {
    category: 'LOCATION',
    rule: 'location',
    re: /location|city|address|zip\s*code|postal|where\s+(?:are\s+you|do\s+you)\s+(?:based|located|live)/,
  },
  {
    category: 'START_DATE',
    rule: 'start-date',
    re: /start\s*date|when\s+can\s+you\s+(?:start|join)|earliest\s+(?:start|available)|available\s+to\s+start|when\s+would\s+you\s+(?:be\s+able\s+to\s+)?start|joining\s+date|availability/,
  },
  {
    category: 'NOTICE_PERIOD',
    rule: 'notice-period',
    re: /notice\s*period|how\s+long\s+(?:is\s+)?your\s+notice|notice\s+require/,
  },
  {
    category: 'SALARY',
    rule: 'salary',
    re: /salary|compensation|pay\s+(?:expectation|range|requirement)|expected\s+(?:salary|compensation|pay)|desired\s+salary|remuneration|\bctc\b|package\s+expectation/,
  },
  {
    category: 'EDUCATION',
    rule: 'education',
    re: /education|degree|university|college|school|academic|qualification|institution|major|field\s+of\s+study|\bgpa\b/,
  },
  {
    category: 'SKILLS',
    rule: 'skills',
    re: /skills?|technical\s+skills?|core\s+competenc|technologies|tech\s+stack|competenc|proficien|programming\s+languages|tools?\s+you|familiar\s+with/,
  },
  {
    category: 'EXPERIENCE',
    rule: 'experience',
    re: /work\s+experience|employment\s+history|professional\s+experience|relevant\s+experience|work\s+history|career\s+history|industry\s+experience|employment\s+experience|^experience\b|experience\s*[:?]?\s*$/,
  },
];

/** Categories produced by natural-language generation (the AI path). */
export const AI_CATEGORIES: ReadonlySet<QuestionCategory> = new Set<QuestionCategory>([
  'COVER_LETTER',
  'MOTIVATION',
  'WHY_COMPANY',
  'WHY_ROLE',
  'EXPERIENCE_DESCRIPTION',
]);

export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^a-z0-9'?:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function categoryFromSemantic(question: QuestionInput): QuestionCategory | null {
  const semantic = question.locator?.attributes?.semantic;
  if (!semantic) return null;
  return SEMANTIC_TO_CATEGORY[semantic] ?? null;
}

function strategyFor(category: QuestionCategory, fieldType?: string | null): AnswerStrategy {
  // File uploads (resume, cover-letter file) are never auto-answered here.
  if (fieldType === 'FILE') return 'MANUAL';
  if (AI_CATEGORIES.has(category)) return 'AI';
  if (category === 'OTHER') return 'MANUAL';
  return 'DETERMINISTIC';
}

/**
 * Deterministically classify a question. Order of trust:
 *  1. normalized `semantic` tag (recorded by the adapter), when it maps;
 *  2. structured field type for EMAIL/PHONE;
 *  3. ordered label keyword rules;
 *  4. OTHER (unknown -> needs review, never guessed).
 */
export function classifyQuestion(question: QuestionInput): QuestionClassification {
  // 1. semantic hint
  const fromSemantic = categoryFromSemantic(question);
  if (fromSemantic) {
    return {
      category: fromSemantic,
      strategy: strategyFor(fromSemantic, question.fieldType),
      matchedBy: 'semantic',
      matchedRule: question.locator?.attributes?.semantic ?? null,
    };
  }

  // 2. structural field types
  const fieldType = question.fieldType ?? undefined;
  if (fieldType === 'EMAIL') {
    return { category: 'EMAIL', strategy: strategyFor('EMAIL', fieldType), matchedBy: 'fieldType', matchedRule: 'EMAIL' };
  }
  if (fieldType === 'PHONE') {
    return { category: 'PHONE', strategy: strategyFor('PHONE', fieldType), matchedBy: 'fieldType', matchedRule: 'PHONE' };
  }

  // 3. ordered label rules
  const haystack = normalizeLabel(question.label);
  for (const { category, rule, re } of LABEL_RULES) {
    if (re.test(haystack)) {
      return { category, strategy: strategyFor(category, fieldType), matchedBy: 'label', matchedRule: rule };
    }
  }

  // 4. unknown
  return { category: 'OTHER', strategy: 'MANUAL', matchedBy: 'default', matchedRule: null };
}
