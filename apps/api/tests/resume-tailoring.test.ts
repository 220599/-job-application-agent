import { describe, it, expect } from 'vitest';
import { AiError, createMockAiProvider, createUnavailableAiProvider } from '@jaa/ai';
import {
  buildTailoringContext,
  buildTailoringPrompt,
  derivedYearsLabel,
  parseTailoredContent,
  tailorResumeContent,
  validateTailoredContent,
  changeSummaryFor,
  TAILORING_STRATEGY,
  type TailoredResumeContent,
  type TailoringContext,
  type TailorJobContext,
} from '@jaa/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function richContext(): TailoringContext {
  return buildTailoringContext({
    profile: {
      firstName: 'Alice',
      lastName: 'Nguyen',
      preferredName: 'Ali',
      email: 'alice@example.com',
      phone: '+1 555 0100',
      location: 'San Francisco, CA',
      city: 'San Francisco',
      state: 'CA',
      country: 'US',
      linkedinUrl: 'https://linkedin.com/in/alice',
      githubUrl: 'https://github.com/alice',
      portfolioUrl: 'https://alice.dev',
      websiteUrl: 'https://alice.io',
      workAuthorization: 'US_CITIZEN',
      desiredRoles: ['Staff Engineer'],
      summary: 'Senior engineer focused on distributed systems.',
    },
    experience: [
      {
        id: 'exp-1',
        title: 'Senior Engineer',
        company: 'Acme Corp',
        startDate: '2019-01-01',
        isCurrent: true,
        description: 'Built data pipelines with SQL and Python. Reduced report time by 50%.',
      },
    ],
    education: [
      {
        id: 'edu-1',
        institution: 'State University',
        degree: 'Bachelor of Science',
        fieldOfStudy: 'Computer Science',
        startDate: '2012-09-01',
        endDate: '2016-06-01',
      },
    ],
    skills: [
      { name: 'TypeScript', proficiency: 'ADVANCED' },
      { name: 'SQL', proficiency: 'ADVANCED' },
      { name: 'Python', proficiency: 'INTERMEDIATE' },
    ],
    source: {
      extractedText:
        'Alice Nguyen. Senior Engineer at Acme Corp. Worked with SQL and Python. Reduced report time by 50%.',
      parsedData: null,
    },
  });
}

const JOB: TailorJobContext = {
  company: 'InnovateCo',
  title: 'Staff Engineer',
  location: 'Remote',
  description: 'Build data platforms. Requirements: strong SQL and Python.',
  requirements: ['Strong SQL', 'Python experience'],
  responsibilities: ['Design data pipelines'],
  skills: ['SQL', 'Python'],
};

const VALID_OUTPUT: TailoredResumeContent = {
  summary: 'Senior engineer focused on distributed systems, specializing in SQL and Python.',
  skills: ['SQL', 'Python', 'TypeScript'],
  experience: [
    {
      experienceId: 'exp-1',
      company: 'Acme Corp',
      title: 'Senior Engineer',
      bullets: [
        'Built data pipelines with SQL and Python',
        'Reduced report time by 50%',
      ],
    },
  ],
  education: [
    {
      educationId: 'edu-1',
      institution: 'State University',
      degree: 'Bachelor of Science',
      fieldOfStudy: 'Computer Science',
      details: ['Studied Computer Science'],
    },
  ],
};

function check(content: unknown, ctx = richContext()) {
  return validateTailoredContent(content, ctx);
}

function violationTypes(result: { violations: { type: string }[] }): string[] {
  return result.violations.map((v) => v.type);
}

function okJson(content: unknown): string {
  return JSON.stringify(content);
}

// ---------------------------------------------------------------------------
// Validation: allowed transformations
// ---------------------------------------------------------------------------

describe('resume tailoring validation - allowed transformations', () => {
  it('accepts fully valid grounded content', () => {
    const result = check(VALID_OUTPUT);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('allows rewriting an existing bullet as long as figures stay supported', () => {
    const result = check({
      ...VALID_OUTPUT,
      experience: [
        {
          company: 'Acme Corp',
          title: 'Senior Engineer',
          bullets: ['Engineered SQL and Python data pipelines, cutting report time by 50%'],
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('allows reordering and emphasizing existing skills', () => {
    const result = check({ ...VALID_OUTPUT, skills: ['Python', 'SQL'] });
    expect(result.valid).toBe(true);
  });

  it('allows rewriting the summary using existing facts', () => {
    const result = check({
      ...VALID_OUTPUT,
      summary: 'Distributed systems engineer specializing in SQL data platforms.',
    });
    expect(result.valid).toBe(true);
  });

  it('allows removing less relevant content (dropped sections)', () => {
    const result = check({ skills: ['SQL'] });
    expect(result.valid).toBe(true);
    const bare = check({ summary: 'Senior engineer.' });
    expect(bare.valid).toBe(true);
  });

  it('normalizes employer names (case, punctuation, corporate suffixes)', () => {
    const result = check({
      ...VALID_OUTPUT,
      experience: [
        { company: 'ACME, Inc.', title: 'senior engineer', bullets: ['Built pipelines with SQL'] },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a metrics claim whose exact figure exists in the source data', () => {
    const result = check({
      ...VALID_OUTPUT,
      experience: [
        { company: 'Acme Corp', title: 'Senior Engineer', bullets: ['Cut report time by 50%'] },
      ],
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation: anti-fabrication rejections
// ---------------------------------------------------------------------------

describe('resume tailoring validation - anti-fabrication', () => {
  it('rejects an invented skill', () => {
    const result = check({ ...VALID_OUTPUT, skills: ['TypeScript', 'Kubernetes'] });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_SKILL');
    expect(result.violations.some((v) => v.value === 'Kubernetes')).toBe(true);
  });

  it('rejects an invented employer', () => {
    const result = check({
      ...VALID_OUTPUT,
      experience: [{ company: 'Globex Corporation', title: 'Senior Engineer', bullets: ['Built things'] }],
    });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_EMPLOYER');
  });

  it('rejects an invented job title', () => {
    const result = check({
      ...VALID_OUTPUT,
      experience: [{ company: 'Acme Corp', title: 'Principal Architect', bullets: ['Built things'] }],
    });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_TITLE');
  });

  it('rejects an invented degree', () => {
    const result = check({
      ...VALID_OUTPUT,
      education: [
        {
          institution: 'State University',
          degree: 'Master of Science',
          fieldOfStudy: 'Computer Science',
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_DEGREE');
  });

  it('rejects an invented institution', () => {
    const result = check({
      ...VALID_OUTPUT,
      education: [
        { institution: 'MIT', degree: 'Bachelor of Science', fieldOfStudy: 'Computer Science' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_INSTITUTION');
  });

  it('rejects an invented certification in a bullet', () => {
    const result = check({
      ...VALID_OUTPUT,
      experience: [
        {
          company: 'Acme Corp',
          title: 'Senior Engineer',
          bullets: ['AWS Certified Solutions Architect'],
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_CERTIFICATION');
  });

  it('rejects an invented certifications section (unknown field)', () => {
    const result = check({
      ...VALID_OUTPUT,
      certifications: ['AWS Solutions Architect'],
    });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_CERTIFICATION');
  });

  it('rejects an invented quantitative metric', () => {
    const result = check({
      ...VALID_OUTPUT,
      experience: [
        {
          company: 'Acme Corp',
          title: 'Senior Engineer',
          bullets: ['Scaled platforms processing 100M records daily'],
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_METRIC');
  });

  it('rejects an invented date claim in text', () => {
    const result = check({
      ...VALID_OUTPUT,
      experience: [
        { company: 'Acme Corp', title: 'Senior Engineer', bullets: ['Led the team from 2023 to 2025'] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_DATE');
  });

  it('rejects date fields on entries (dates can never be model output)', () => {
    const result = check({
      ...VALID_OUTPUT,
      experience: [
        {
          company: 'Acme Corp',
          title: 'Senior Engineer',
          startDate: '2019-01',
          endDate: '2026-01',
          bullets: ['Built pipelines with SQL'],
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(violationTypes(result).every((t) => t === 'UNSUPPORTED_DATE')).toBe(true);
  });

  it('rejects unknown fields outside the contract', () => {
    const result = check({ ...VALID_OUTPUT, awards: ['Best Engineer'] });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_FIELD');
    expect(result.violations.some((v) => v.value === 'awards')).toBe(true);
  });

  it('rejects an unknown experienceId reference', () => {
    const result = check({
      ...VALID_OUTPUT,
      experience: [
        { experienceId: 'exp-999', company: 'Acme Corp', title: 'Senior Engineer', bullets: ['x'] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('UNSUPPORTED_FIELD');
  });

  it('rejects an empty output', () => {
    const result = check({});
    expect(result.valid).toBe(false);
    expect(violationTypes(result)).toContain('EMPTY_OUTPUT');
    expect(check(null).valid).toBe(false);
  });

  it('accepts company/title pairs that come from parsed source resume data', () => {
    const ctx = richContext();
    ctx.source.parsedData = {
      experience: [{ company: 'Beta LLC', title: 'Data Engineer', startDate: '2016-07', endDate: '2018-12', isCurrent: false }],
    };
    const result = check(
      {
        experience: [{ company: 'Beta', title: 'Data Engineer', bullets: ['Maintained pipelines'] }],
      },
      ctx
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structured output parsing
// ---------------------------------------------------------------------------

describe('parseTailoredContent', () => {
  it('parses plain JSON output', () => {
    const parsed = parseTailoredContent(okJson(VALID_OUTPUT));
    expect(parsed.error).toBeNull();
    expect(parsed.content?.skills).toEqual(VALID_OUTPUT.skills);
  });

  it('parses fenced and prose-wrapped JSON', () => {
    const fenced = parseTailoredContent('```json\n' + okJson(VALID_OUTPUT) + '\n```');
    expect(fenced.error).toBeNull();
    const wrapped = parseTailoredContent('Here is the tailored resume:\n' + okJson(VALID_OUTPUT) + '\nDone.');
    expect(wrapped.error).toBeNull();
    expect(wrapped.content?.summary).toBe(VALID_OUTPUT.summary);
  });

  it('reports structured failures instead of guessing', () => {
    expect(parseTailoredContent('').error).toBe('AI_EMPTY_RESPONSE');
    expect(parseTailoredContent('   ').error).toBe('AI_EMPTY_RESPONSE');
    expect(parseTailoredContent('not json at all').error).toBe('AI_INVALID_RESPONSE');
    expect(parseTailoredContent('[1, 2, 3]').error).toBe('AI_INVALID_RESPONSE');
    expect(parseTailoredContent('{"summary": broken').error).toBe('AI_INVALID_RESPONSE');
  });

  it('treats the NEEDS_REVIEW sentinel as a review request, never content', () => {
    expect(parseTailoredContent('NEEDS_REVIEW').error).toBe('MODEL_REQUESTED_REVIEW');
  });
});

// ---------------------------------------------------------------------------
// Prompt: grounding and privacy
// ---------------------------------------------------------------------------

describe('buildTailoringPrompt', () => {
  const prompt = buildTailoringPrompt(richContext(), JOB);

  it('carries strict anti-fabrication rules and the structured contract', () => {
    expect(prompt).toContain('STRICT GROUNDING RULES');
    expect(prompt).toContain('Do not invent or fabricate any information');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"experience"');
    expect(prompt).toContain('"education"');
    expect(prompt).toContain('NEEDS_REVIEW');
  });

  it('includes scoped candidate facts and the job context', () => {
    expect(prompt).toContain('Acme Corp');
    expect(prompt).toContain('Senior Engineer');
    expect(prompt).toContain('TypeScript');
    expect(prompt).toContain('State University');
    expect(prompt).toContain('InnovateCo');
    expect(prompt).toContain('Staff Engineer');
    expect(prompt).toContain('Strong SQL');
    expect(prompt).toContain('Source resume text');
  });

  it('never includes unrelated candidate data (salary, sponsorship)', () => {
    expect(prompt.toLowerCase()).not.toContain('salary');
    expect(prompt.toLowerCase()).not.toContain('sponsorship');
  });

  it('forbids invented dates and metrics', () => {
    expect(prompt).toContain('Do not invent or alter any employment or education dates');
    expect(prompt).toContain('Do not add quantitative claims');
  });
});

// ---------------------------------------------------------------------------
// AI tailoring step: safe failure
// ---------------------------------------------------------------------------

describe('tailorResumeContent - safe failure', () => {
  it('fails structurally when no provider is configured (no fake resume)', async () => {
    const result = await tailorResumeContent({ ctx: richContext(), job: JOB, aiProvider: null });
    expect(result.errorCode).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(result.content).toBeNull();
  });

  it('maps provider failures to structured codes (unavailable / timeout / generic)', async () => {
    const unavailable = await tailorResumeContent({
      ctx: richContext(),
      job: JOB,
      aiProvider: createUnavailableAiProvider(),
    });
    expect(unavailable.errorCode).toBe('AI_PROVIDER_UNAVAILABLE');

    const timeout = createMockAiProvider({
      handler: () => {
        throw new AiError('AI_TIMEOUT', 'timed out');
      },
    });
    const timeoutResult = await tailorResumeContent({ ctx: richContext(), job: JOB, aiProvider: timeout });
    expect(timeoutResult.errorCode).toBe('AI_TIMEOUT');

    const generic = createMockAiProvider({
      handler: () => {
        throw new Error('boom');
      },
    });
    const genericResult = await tailorResumeContent({ ctx: richContext(), job: JOB, aiProvider: generic });
    expect(genericResult.errorCode).toBe('AI_REQUEST_FAILED');
  });

  it('treats empty and invalid model output as structured failures', async () => {
    const empty = await tailorResumeContent({
      ctx: richContext(),
      job: JOB,
      aiProvider: createMockAiProvider({ defaultText: '' }),
    });
    expect(empty.errorCode).toBe('AI_EMPTY_RESPONSE');

    const invalid = await tailorResumeContent({
      ctx: richContext(),
      job: JOB,
      aiProvider: createMockAiProvider({ defaultText: 'definitely not json' }),
    });
    expect(invalid.errorCode).toBe('AI_INVALID_RESPONSE');

    const review = await tailorResumeContent({
      ctx: richContext(),
      job: JOB,
      aiProvider: createMockAiProvider({ defaultText: 'NEEDS_REVIEW' }),
    });
    expect(review.errorCode).toBe('MODEL_REQUESTED_REVIEW');
  });

  it('rejects fabricated model output with structured violations', async () => {
    const fabricated = {
      ...VALID_OUTPUT,
      skills: ['TypeScript', 'Kubernetes'],
      experience: [
        {
          company: 'Globex Corporation',
          title: 'VP of Engineering',
          bullets: ['Delivered 10x growth in 2027'],
        },
      ],
    };
    const result = await tailorResumeContent({
      ctx: richContext(),
      job: JOB,
      aiProvider: createMockAiProvider({ defaultText: okJson(fabricated) }),
    });
    expect(result.errorCode).toBe('VALIDATION_FAILED');
    expect(result.content).toBeNull();
    expect(result.violations.length).toBeGreaterThan(0);
    expect(violationTypes(result)).toContain('UNSUPPORTED_SKILL');
  });

  it('returns grounded content and provenance on success', async () => {
    const provider = createMockAiProvider({ defaultText: okJson(VALID_OUTPUT) });
    const result = await tailorResumeContent({ ctx: richContext(), job: JOB, aiProvider: provider });
    expect(result.errorCode).toBeNull();
    expect(result.validation?.valid).toBe(true);
    expect(result.content?.skills).toEqual(['SQL', 'Python', 'TypeScript']);
    expect(result.provider).toBe('mock-ai');
    expect(provider.prompts[0]).toContain('STRICT GROUNDING RULES');
  });
});

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

describe('tailoring helpers', () => {
  it('derives whole years from stored dates only', () => {
    expect(derivedYearsLabel(7.7)).toBe('7 years');
    expect(derivedYearsLabel(null)).toBeNull();
    expect(derivedYearsLabel(Number.NaN)).toBeNull();
  });

  it('builds a change summary from the actual job record', () => {
    expect(changeSummaryFor({ title: 'Staff Engineer', company: 'InnovateCo' })).toBe(
      'Tailored for Staff Engineer role at InnovateCo'
    );
  });

  it('uses a stable versioned strategy identity', () => {
    expect(TAILORING_STRATEGY).toBe('JOB_ALIGNED_V1');
  });
});
