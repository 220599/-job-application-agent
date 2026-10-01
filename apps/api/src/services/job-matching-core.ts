/**
 * Phase 5 - Job Matching Engine (deterministic core)
 *
 * Pure, framework-free matching logic. No Express, no Prisma, no AI.
 * It compares a stored Job against the candidate's stored profile data and
 * produces a transparent, explainable match result.
 *
 * Design rules:
 *  - Deterministic: the same inputs always produce the same output.
 *  - Missing information is handled gracefully: a factor that cannot be
 *    evaluated is marked NOT_APPLICABLE and its weight is redistributed
 *    across the remaining factors. Missing salary/location/etc. never
 *    zeroes a job out.
 *  - No fabrication: only data present on the Job and CandidateProfile
 *    (plus Skills/Experience rows) is ever used as evidence.
 *  - Work authorization is only evaluated when the job data EXPLICITLY
 *    states a relevant requirement; the engine never assumes immigration
 *    eligibility and never rejects a job over unstated requirements.
 */

// ============================================================================
// Types
// ============================================================================

export type MatchFactorStatus = 'MET' | 'PARTIAL' | 'UNMET' | 'NOT_APPLICABLE';

export type MatchFactorKey =
  | 'skills'
  | 'role'
  | 'experience'
  | 'location'
  | 'salary'
  | 'employmentAuthorization';

export interface MatchFactorResult {
  key: MatchFactorKey;
  label: string;
  weight: number;
  /** 0-100, or null when the factor could not be evaluated */
  score: number | null;
  status: MatchFactorStatus;
  matched: string[];
  missing: string[];
  notes: string[];
}

export interface MatchCriterion {
  criterion: string;
  status: MatchFactorStatus;
  detail: string;
}

export interface MatchJobInput {
  id?: string;
  title: string;
  company?: string;
  location?: string | null;
  description?: string | null;
  employmentType?: string | null;
  workMode?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  requirements?: string[] | null;
  responsibilities?: string[] | null;
  skills?: string[] | null;
}

export interface MatchProfileInput {
  workAuthorization?: string;
  sponsorshipRequired?: boolean;
  willingToRelocate?: boolean;
  preferredWorkMode?: string; // REMOTE | HYBRID | ONSITE | ANY
  preferredLocations?: string[];
  desiredRoles?: string[];
  desiredSalaryMin?: number | null;
  desiredSalaryMax?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface MatchSkillInput {
  name: string;
  proficiency?: string;
  yearsOfExperience?: number | null;
}

export interface MatchExperienceInput {
  company?: string;
  title: string;
  employmentType?: string;
  description?: string | null;
  isCurrent?: boolean;
}

export interface MatchInput {
  job: MatchJobInput;
  profile: MatchProfileInput;
  skills: MatchSkillInput[];
  experience: MatchExperienceInput[];
}

export interface MatchComputation {
  overallScore: number;
  factors: MatchFactorResult[];
  matchedSkills: string[];
  missingSkills: string[];
  matchedCriteria: MatchCriterion[];
  concerns: string[];
  strengths: string[];
  gaps: string[];
  explanation: string;
}

/** Nominal weights (sum = 100). Unused weight is redistributed. */
export const MATCH_WEIGHTS: Record<MatchFactorKey, number> = {
  skills: 40,
  role: 20,
  experience: 15,
  location: 10,
  salary: 10,
  employmentAuthorization: 5,
};

/**
 * Interface for a future AI explanation/enrichment layer.
 * NOT used by the deterministic engine (Phase 5 keeps scoring AI-free).
 */
export interface MatchExplainer {
  enrich(computation: MatchComputation, input: MatchInput): Promise<string | null>;
}

/** Default no-op explainer so the engine works fully offline. */
export const noopExplainer: MatchExplainer = {
  async enrich() {
    return null;
  },
};

// ============================================================================
// Normalization helpers
// ============================================================================

/** Common alias -> canonical skill name mapping (case-insensitive). */
const SKILL_ALIASES: Record<string, string> = {
  'amazon web services': 'aws',
  'amazonwebservices': 'aws',
  postgres: 'postgresql',
  'postgre sql': 'postgresql',
  pgsql: 'postgresql',
  psql: 'postgresql',
  js: 'javascript',
  'node.js': 'nodejs',
  node: 'nodejs',
  ts: 'typescript',
  k8s: 'kubernetes',
  golang: 'go',
  reactjs: 'react',
  'react.js': 'react',
  nextjs: 'nextjs',
  'next.js': 'nextjs',
  vuejs: 'vue',
  'vue.js': 'vue',
  'angular.js': 'angular',
  angularjs: 'angular',
  'c#': 'csharp',
  'c++': 'cpp',
  ml: 'machine learning',
  ai: 'artificial intelligence',
  rest: 'rest api',
  restful: 'rest api',
  microservices: 'microservices',
};

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'our', 'plus', 'strong', 'the', 'their', 'to',
  'with', 'you', 'your', 'we', 'will', 'other', 'others', 'experience',
  'years', 'year', 'knowledge', 'familiarity', 'proficiency', 'skills',
  'ability', 'working', 'work', 'excellent', 'good', 'great', 'preferred',
  'required', 'requirement', 'requirements', 'must', 'have', 'has', 'not',
  'etc', 'us', 'usa', 'new', 'based',
]);

/** Seniority words ignored when comparing job titles with desired roles. */
const SENIORITY_WORDS = new Set([
  'senior', 'junior', 'sr', 'jr', 'lead', 'principal', 'staff', 'head',
  'intern', 'internship', 'i', 'ii', 'iii', 'iv', 'entry', 'level', 'associate',
]);

export function normalizeSkill(name: string): string {
  const cleaned = name.toLowerCase().trim().replace(/[^a-z0-9+#. ]/g, ' ').replace(/\s+/g, ' ').trim();
  return SKILL_ALIASES[cleaned] ?? cleaned;
}

function skillVariants(name: string): string[] {
  const normalized = normalizeSkill(name);
  const variants = new Set<string>([normalized]);
  // Also allow matching without the canonical alias (e.g. 'aws' vs 'amazon web services')
  for (const [alias, canonical] of Object.entries(SKILL_ALIASES)) {
    if (canonical === normalized) variants.add(alias);
  }
  return [...variants];
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Title tokens with seniority words removed, for role comparison. */
export function titleTokens(title: string): string[] {
  return tokenize(title).filter((t) => !SENIORITY_WORDS.has(t));
}

export function normalizeLocation(loc: string): string {
  return loc.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ============================================================================
// Factor scorers
// ============================================================================

interface FactorOptions {
  matched: string[];
  missing: string[];
  notes: string[];
}

function factor(
  key: MatchFactorKey,
  label: string,
  weight: number,
  score: number | null,
  { matched, missing, notes }: FactorOptions
): MatchFactorResult {
  const clamped = score === null ? null : Math.max(0, Math.min(100, Math.round(score)));
  let status: MatchFactorStatus;
  if (clamped === null) status = 'NOT_APPLICABLE';
  else if (clamped >= 75) status = 'MET';
  else if (clamped >= 40) status = 'PARTIAL';
  else status = 'UNMET';
  return { key, label, weight, score: clamped, status, matched, missing, notes };
}

/** 1. Skills: job skills vs candidate skills (normalized + aliases). */
export function scoreSkills(
  job: MatchJobInput,
  skills: MatchSkillInput[]
): MatchFactorResult {
  const jobSkills = (job.skills ?? []).map((s) => s.trim()).filter(Boolean);
  const candidateSkills = skills.map((s) => s.name.trim()).filter(Boolean);

  if (jobSkills.length === 0) {
    return factor('skills', 'Skills', MATCH_WEIGHTS.skills, null, {
      matched: [],
      missing: [],
      notes: ['Job does not list required skills'],
    });
  }

  if (candidateSkills.length === 0) {
    return factor('skills', 'Skills', MATCH_WEIGHTS.skills, 0, {
      matched: [],
      missing: jobSkills,
      notes: ['Your profile has no skills listed yet'],
    });
  }

  const candidateVariants = new Set<string>();
  for (const cs of candidateSkills) {
    for (const v of skillVariants(cs)) candidateVariants.add(v);
  }

  const matched: string[] = [];
  const missing: string[] = [];
  for (const js of jobSkills) {
    const variants = skillVariants(js);
    if (variants.some((v) => candidateVariants.has(v))) {
      matched.push(js);
    } else {
      missing.push(js);
    }
  }

  const score = (matched.length / jobSkills.length) * 100;
  const notes: string[] = [`Matched ${matched.length} of ${jobSkills.length} required skills`];
  return factor('skills', 'Skills', MATCH_WEIGHTS.skills, score, { matched, missing, notes });
}

/** 2. Role: job title vs CandidateProfile.desiredRoles. */
export function scoreRole(job: MatchJobInput, profile: MatchProfileInput): MatchFactorResult {
  const desired = (profile.desiredRoles ?? []).map((r) => r.trim()).filter(Boolean);

  if (desired.length === 0) {
    return factor('role', 'Desired role', MATCH_WEIGHTS.role, null, {
      matched: [],
      missing: [],
      notes: ['No desired roles set on your profile'],
    });
  }

  const jobTokens = new Set(titleTokens(job.title));
  let best = { score: 0, role: desired[0] };

  for (const role of desired) {
    const roleTokens = new Set(titleTokens(role));
    if (roleTokens.size === 0) continue;
    // Exact when the raw strings match OR the seniority-stripped token sets match
    // (e.g. "Senior Software Engineer" is an exact match for "Software Engineer").
    const jobTok = titleTokens(job.title).join(' ');
    const exact =
      job.title.toLowerCase().trim() === role.toLowerCase().trim() ||
      (jobTok.length > 0 && jobTok === titleTokens(role).join(' '));
    const overlapTokens = [...roleTokens].filter((t) => jobTokens.has(t));
    const overlap = overlapTokens.length / roleTokens.size;

    let score: number;
    if (exact) score = 100;
    else if (
      normalizeLocation(job.title).includes(normalizeLocation(role)) ||
      normalizeLocation(role).includes(normalizeLocation(job.title))
    ) {
      score = 90;
    } else if (overlap >= 0.5) score = 75;
    else if (overlap > 0) score = 40;
    else score = 0;

    if (score > best.score) best = { score, role };
  }

  const notes: string[] = [
    best.score >= 75
      ? `Title "${job.title}" closely matches desired role "${best.role}"`
      : best.score > 0
        ? `Title "${job.title}" is related to desired role "${best.role}"`
        : `Title "${job.title}" does not match your desired roles`,
  ];
  const matched = best.score >= 75 ? [best.role] : [];
  const missing = best.score >= 75 ? [] : [best.role];
  return factor('role', 'Desired role', MATCH_WEIGHTS.role, best.score, {
    matched,
    missing,
    notes,
  });
}

/** 3. Experience: job requirements evidenced by stored experience/skills. */
export function scoreExperience(
  job: MatchJobInput,
  skills: MatchSkillInput[],
  experience: MatchExperienceInput[]
): MatchFactorResult {
  const requirements = (job.requirements ?? []).map((r) => r.trim()).filter(Boolean);

  if (requirements.length === 0) {
    return factor('experience', 'Experience fit', MATCH_WEIGHTS.experience, null, {
      matched: [],
      missing: [],
      notes: ['Job does not list explicit requirements'],
    });
  }

  // Evidence sources: stored skills + stored experience titles/descriptions/companies.
  const evidenceTokens = new Set<string>();
  for (const s of skills) {
    for (const v of skillVariants(s.name)) {
      evidenceTokens.add(v);
      tokenize(v).forEach((t) => evidenceTokens.add(t));
    }
  }
  for (const e of experience) {
    titleTokens(e.title).forEach((t) => evidenceTokens.add(t));
    normalizeLocation(e.company ?? '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
      .forEach((t) => evidenceTokens.add(t));
    if (e.description) tokenize(e.description).forEach((t) => evidenceTokens.add(t));
  }

  const matched: string[] = [];
  const missing: string[] = [];
  for (const req of requirements) {
    const tokens = tokenize(req);
    const evidenced = tokens.some((t) => evidenceTokens.has(t) || evidenceTokens.has(SKILL_ALIASES[t] ?? t));
    (evidenced ? matched : missing).push(req);
  }

  if (experience.length === 0 && skills.length === 0) {
    return factor('experience', 'Experience fit', MATCH_WEIGHTS.experience, 0, {
      matched: [],
      missing: requirements,
      notes: ['No experience or skills stored, so requirements could not be verified'],
    });
  }

  const score = (matched.length / requirements.length) * 100;
  return factor('experience', 'Experience fit', MATCH_WEIGHTS.experience, score, {
    matched,
    missing,
    notes: [`${matched.length} of ${requirements.length} requirements are backed by your stored experience/skills`],
  });
}

/**
 * 4. Location / work mode.
 *
 * Score matrix for work-mode preference vs the job's work mode
 * (when the job does NOT offer remote work):
 *   exact match or candidate is ANY -> 100
 *   adjacent preference (REMOTE<->HYBRID, HYBRID<->ONSITE) -> 60
 *   opposite preference (REMOTE vs ONSITE) -> 30
 * For remote jobs: REMOTE/ANY preference -> 100, HYBRID -> 75, ONSITE -> 40.
 *
 * Location text only matters when the job is not fully remote or the work
 * mode is unknown; unwillingness to relocate reduces the score.
 */
export function scoreLocation(job: MatchJobInput, profile: MatchProfileInput): MatchFactorResult {
  const jobMode = (job.workMode ?? '').toUpperCase();
  const prefMode = (profile.preferredWorkMode ?? 'ANY').toUpperCase();
  const jobLocation = (job.location ?? '').trim();
  const preferredLocations = (profile.preferredLocations ?? []).map((l) => l.trim()).filter(Boolean);

  if (!jobMode && !jobLocation) {
    return factor('location', 'Location & work mode', MATCH_WEIGHTS.location, null, {
      matched: [],
      missing: [],
      notes: ['Job lists no work mode or location'],
    });
  }

  const notes: string[] = [];
  let score: number | null = null;
  let matched: string[] = [];
  const missing: string[] = [];

  const locationMatchesPreferred = (): boolean => {
    if (preferredLocations.length === 0 || !jobLocation) return false;
    const jobLoc = normalizeLocation(jobLocation);
    return preferredLocations.some((p) => {
      const np = normalizeLocation(p);
      return np.length > 0 && (jobLoc.includes(np) || np.includes(jobLoc));
    });
  };

  const candidateLocation = [profile.city, profile.state, profile.country]
    .filter(Boolean)
    .map((l) => normalizeLocation(String(l)))
    .filter(Boolean);

  const locationMatchesCandidate = (): boolean => {
    if (!jobLocation || candidateLocation.length === 0) return false;
    const jobLoc = normalizeLocation(jobLocation);
    return candidateLocation.some((c) => jobLoc.includes(c) || c.includes(jobLoc));
  };

  if (jobMode === 'REMOTE') {
    if (prefMode === 'REMOTE' || prefMode === 'ANY') score = 100;
    else if (prefMode === 'HYBRID') score = 75;
    else if (prefMode === 'ONSITE') score = 40;
    else score = null;
    if (score !== null) notes.push(`Job is remote (your preference: ${prefMode})`);
    if (score === 100) matched = ['Remote work'];
  } else if (jobMode === 'HYBRID' || jobMode === 'ONSITE') {
    if (prefMode === 'ANY' || prefMode === jobMode) score = 100;
    else if (
      (prefMode === 'REMOTE' && jobMode === 'HYBRID') ||
      prefMode === 'HYBRID'
    ) {
      score = 60;
    } else if (prefMode === 'REMOTE' && jobMode === 'ONSITE') score = 30;
    else score = 60;

    if (locationMatchesPreferred() || locationMatchesCandidate()) {
      score = Math.max(score ?? 0, 100);
      matched = [`Location: ${jobLocation}`];
      notes.push(`Job location "${jobLocation}" matches your preferred locations`);
    } else if (profile.willingToRelocate) {
      notes.push(`Relocation may be needed for "${jobLocation || 'this location'}" (you are open to relocating)`);
    } else if (preferredLocations.length > 0 || candidateLocation.length > 0) {
      score = Math.round((score ?? 60) * 0.6);
      missing.push(jobLocation || 'On-site presence');
      notes.push(`Job location "${jobLocation || 'unspecified'}" is outside your preferred locations and relocation is off`);
    } else {
      notes.push(`No location preference set on your profile`);
    }
  } else {
    // Work mode unknown; judge by location text only.
    if (!jobLocation) {
      return factor('location', 'Location & work mode', MATCH_WEIGHTS.location, null, {
        matched: [],
        missing: [],
        notes: ['Job lists no work mode or location'],
      });
    }
    if (locationMatchesPreferred() || locationMatchesCandidate()) {
      score = 100;
      matched = [`Location: ${jobLocation}`];
      notes.push(`Job location "${jobLocation}" matches your preferences`);
    } else if (profile.willingToRelocate) {
      score = 75;
      notes.push(`Job is in "${jobLocation}"; you are open to relocating`);
    } else if (preferredLocations.length > 0 || candidateLocation.length > 0) {
      score = 30;
      missing.push(jobLocation);
      notes.push(`Job is in "${jobLocation}", outside your preferred locations`);
    } else {
      return factor('location', 'Location & work mode', MATCH_WEIGHTS.location, null, {
        matched: [],
        missing: [],
        notes: ['Job work mode unknown and no location preference set on your profile'],
      });
    }
  }

  return factor('location', 'Location & work mode', MATCH_WEIGHTS.location, score, {
    matched,
    missing,
    notes,
  });
}

/** 5. Salary: overlap between job range and desired range. Never penalized when either side is missing. */
export function scoreSalary(job: MatchJobInput, profile: MatchProfileInput): MatchFactorResult {
  const jobMin = job.salaryMin ?? null;
  const jobMax = job.salaryMax ?? null;
  const candMin = profile.desiredSalaryMin ?? null;
  const candMax = profile.desiredSalaryMax ?? null;

  if (jobMin === null && jobMax === null) {
    return factor('salary', 'Salary', MATCH_WEIGHTS.salary, null, {
      matched: [],
      missing: [],
      notes: ['Job does not publish a salary range'],
    });
  }
  if (candMin === null && candMax === null) {
    return factor('salary', 'Salary', MATCH_WEIGHTS.salary, null, {
      matched: [],
      missing: [],
      notes: ['No desired salary set on your profile'],
    });
  }

  const jobCurrency = (job.salaryCurrency ?? 'USD').toUpperCase();
  const candCurrency = 'USD'; // profile desired salary has no currency field; stored values are annual USD
  if (jobCurrency !== candCurrency) {
    return factor('salary', 'Salary', MATCH_WEIGHTS.salary, null, {
      matched: [],
      missing: [],
      notes: [`Job salary is in ${jobCurrency}; cannot compare with your USD expectations`],
    });
  }

  const lo = jobMin ?? jobMax ?? 0;
  const hi = jobMax ?? jobMin ?? 0;

  if (hi >= (candMin ?? 0)) {
    const above = (candMax ?? 0) > 0 && lo > (candMax ?? 0);
    return factor('salary', 'Salary', MATCH_WEIGHTS.salary, 100, {
      matched: [`Job range ${lo.toLocaleString()}-${hi.toLocaleString()} meets your expectation`],
      missing: [],
      notes: [above ? 'Job range is above your desired range' : 'Job range overlaps your desired range'],
    });
  }

  const gap = (candMin ?? 0) - hi;
  const gapRatio = candMin ? gap / candMin : 1;
  if (gapRatio <= 0.1) {
    return factor('salary', 'Salary', MATCH_WEIGHTS.salary, 50, {
      matched: [],
      missing: [`Salary: job tops out at ${hi.toLocaleString()} vs your minimum ${candMin?.toLocaleString()}`],
      notes: [`Job max is within 10% of your desired minimum`],
    });
  }
  return factor('salary', 'Salary', MATCH_WEIGHTS.salary, 0, {
    matched: [],
    missing: [`Salary: job range tops out at ${hi.toLocaleString()}, below your minimum ${candMin?.toLocaleString()}`],
    notes: ['Job range is below your desired minimum'],
  });
}

const AUTH_REQUIREMENT_PATTERNS: { re: RegExp; kind: 'no_sponsorship' | 'citizenship' | 'clearance' }[] = [
  { re: /(no|without|does not (offer|provide|support))\s+(visa\s+)?sponsorship|unsponsored/i, kind: 'no_sponsorship' },
  { re: /(u\.?s\.?|united states|us)\s+(citizen|citizenship)|citizenship (required|only)|must be a .*citizen/i, kind: 'citizenship' },
  { re: /security clearance|clearable|clearance[- ]eligible/i, kind: 'clearance' },
];

/**
 * 6. Employment type + work authorization (combined 5%).
 * Work authorization is only evaluated when the job EXPLICITLY requires
 * something (sponsorship policy, citizenship, clearance). Otherwise it is
 * NOT_APPLICABLE and the employment-type comparison is used when available.
 */
export function scoreEmploymentAndAuth(
  job: MatchJobInput,
  profile: MatchProfileInput,
  experience: MatchExperienceInput[]
): MatchFactorResult {
  const searchText = [
    ...(job.requirements ?? []),
    ...(job.responsibilities ?? []),
    (job.description ?? '').slice(0, 4000),
  ]
    .join(' \n ');

  const explicitAuth = AUTH_REQUIREMENT_PATTERNS.map((p) => {
    const m = searchText.match(p.re);
    return m ? { kind: p.kind, snippet: m[0] } : null;
  }).filter(Boolean) as { kind: string; snippet: string }[];

  if (explicitAuth.length > 0) {
    const auth = (profile.workAuthorization ?? 'OTHER').toUpperCase();
    const sponsorship = profile.sponsorshipRequired ?? false;
    const citizenshipOk = auth.includes('CITIZEN');
    const notes: string[] = [`Job explicitly requires: "${explicitAuth.map((a) => a.snippet).join('", "')}"`];

    for (const req of explicitAuth) {
      if (req.kind === 'no_sponsorship' && sponsorship) {
        return factor('employmentAuthorization', 'Employment & authorization', MATCH_WEIGHTS.employmentAuthorization, 0, {
          matched: [],
          missing: ['Job does not offer sponsorship and your profile requires it'],
          notes,
        });
      }
      if ((req.kind === 'citizenship' || req.kind === 'clearance') && !citizenshipOk) {
        return factor('employmentAuthorization', 'Employment & authorization', MATCH_WEIGHTS.employmentAuthorization, 0, {
          matched: [],
          missing: ['Job requires US citizenship/clearance which is not reflected on your profile'],
          notes,
        });
      }
    }

    return factor('employmentAuthorization', 'Employment & authorization', MATCH_WEIGHTS.employmentAuthorization, 100, {
      matched: ['Work authorization requirement is satisfied by your profile'],
      missing: [],
      notes,
    });
  }

  // Employment type comparison (soft signal based on the candidate's most recent role).
  const jobType = (job.employmentType ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!jobType) {
    return factor('employmentAuthorization', 'Employment & authorization', MATCH_WEIGHTS.employmentAuthorization, null, {
      matched: [],
      missing: [],
      notes: ['Job does not state an employment type and has no explicit authorization requirement'],
    });
  }

  const sorted = [...experience].sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    return 0;
  });
  const latest = sorted[0];

  if (!latest || !latest.employmentType) {
    return factor('employmentAuthorization', 'Employment & authorization', MATCH_WEIGHTS.employmentAuthorization, null, {
      matched: [],
      missing: [],
      notes: ['Job states an employment type, but your profile has no experience to compare against'],
    });
  }

  const candType = latest.employmentType.toUpperCase().replace(/[^A-Z]/g, '');
  if (candType === jobType) {
    return factor('employmentAuthorization', 'Employment & authorization', MATCH_WEIGHTS.employmentAuthorization, 100, {
      matched: [`Employment type ${jobType} matches your most recent role`],
      missing: [],
      notes: [`Based on your most recent role (${latest.title})`],
    });
  }
  return factor('employmentAuthorization', 'Employment & authorization', MATCH_WEIGHTS.employmentAuthorization, 50, {
    matched: [],
    missing: [`Job is ${jobType}; your most recent role was ${candType}`],
    notes: [`Employment type differs from your most recent role (${latest.title})`],
  });
}

// ============================================================================
// Aggregation
// ============================================================================

export function computeJobMatch(input: MatchInput): MatchComputation {
  const { job, profile, skills, experience } = input;

  const factors: MatchFactorResult[] = [
    scoreSkills(job, skills),
    scoreRole(job, profile),
    scoreExperience(job, skills, experience),
    scoreLocation(job, profile),
    scoreSalary(job, profile),
    scoreEmploymentAndAuth(job, profile, experience),
  ];

  const applicable = factors.filter((f) => f.score !== null);
  const totalWeight = applicable.reduce((sum, f) => sum + f.weight, 0);
  let overallScore: number;
  if (applicable.length === 0 || totalWeight === 0) {
    overallScore = 50; // neutral fallback when nothing could be evaluated
  } else {
    overallScore = Math.round(
      applicable.reduce((sum, f) => sum + (f.score as number) * f.weight, 0) / totalWeight
    );
  }
  overallScore = Math.max(0, Math.min(100, overallScore));

  const matchedSkills = factors.find((f) => f.key === 'skills')?.matched ?? [];
  const missingSkills = factors.find((f) => f.key === 'skills')?.missing ?? [];

  const matchedCriteria: MatchCriterion[] = factors.map((f) => ({
    criterion: f.label,
    status: f.status,
    detail:
      f.score === null
        ? f.notes[0] ?? 'Not evaluated'
        : `${f.score}/100 - ${f.notes[0] ?? ''}`.trim(),
  }));

  const concerns = factors.flatMap((f) => [...f.missing, ...f.notes.filter((n) => n.toLowerCase().includes('no ') || n.toLowerCase().includes('below') || n.toLowerCase().includes('outside') || n.toLowerCase().includes('mismatch') || n.toLowerCase().includes('requires') || n.toLowerCase().includes('sponsorship') || n.toLowerCase().includes('not listed') || n.toLowerCase().includes('no experience') || n.toLowerCase().includes('relocation'))]);

  const strengths = factors
    .filter((f) => f.status === 'MET')
    .flatMap((f) => (f.matched.length > 0 ? f.matched : f.notes));

  const gaps = factors
    .filter((f) => f.status === 'UNMET' || f.status === 'PARTIAL')
    .flatMap((f) => (f.missing.length > 0 ? f.missing : f.notes));

  const explanation = buildExplanation(overallScore, factors, matchedSkills, missingSkills);

  return {
    overallScore,
    factors,
    matchedSkills,
    missingSkills,
    matchedCriteria,
    concerns: [...new Set(concerns)],
    strengths: [...new Set(strengths)],
    gaps: [...new Set(gaps)],
    explanation,
  };
}

function buildExplanation(
  overallScore: number,
  factors: MatchFactorResult[],
  matchedSkills: string[],
  missingSkills: string[]
): string {
  const parts: string[] = [];

  const applicable = factors.filter((f) => f.score !== null);
  if (applicable.length === 0) {
    return 'Not enough information on the job or your profile to compute a match. Fill in your profile skills, desired roles, and preferences for a better result.';
  }

  const skillsFactor = factors.find((f) => f.key === 'skills');
  if (skillsFactor && skillsFactor.score !== null) {
    const m = skillsFactor.matched;
    parts.push(
      m.length > 0
        ? `${m.length} of ${m.length + skillsFactor.missing.length} required skills matched${m.length > 0 ? ` (${m.slice(0, 5).join(', ')})` : ''}`
        : `none of the ${skillsFactor.missing.length} required skills are on your profile`
    );
  }
  const roleFactor = factors.find((f) => f.key === 'role');
  if (roleFactor && roleFactor.score !== null) {
    parts.push(
      roleFactor.score >= 75
        ? `the title fits your desired roles`
        : roleFactor.score > 0
          ? `the title is related to your desired roles`
          : `the title differs from your desired roles`
    );
  }
  const locFactor = factors.find((f) => f.key === 'location');
  if (locFactor && locFactor.score !== null) {
    parts.push(locFactor.score >= 75 ? 'location/work mode fits' : locFactor.score >= 40 ? 'location/work mode is a stretch' : 'location/work mode conflicts with your preferences');
  }
  const salFactor = factors.find((f) => f.key === 'salary');
  if (salFactor && salFactor.score !== null) {
    parts.push(salFactor.score >= 75 ? 'salary meets your expectations' : salFactor.score >= 40 ? 'salary is slightly below expectations' : 'salary is below your expectations');
  }
  const expFactor = factors.find((f) => f.key === 'experience');
  if (expFactor && expFactor.score !== null) {
    parts.push(`${expFactor.score >= 75 ? 'most' : expFactor.score >= 40 ? 'some' : 'few'} requirements are backed by your experience`);
  }

  if (missingSkills.length > 0) {
    parts.push(`missing: ${missingSkills.slice(0, 6).join(', ')}`);
  }

  const verdict =
    overallScore >= 80 ? 'Strong match' : overallScore >= 60 ? 'Good match' : overallScore >= 40 ? 'Partial match' : 'Weak match';

  return `${verdict} (${overallScore}%): ${parts.join('; ')}.`;
}
