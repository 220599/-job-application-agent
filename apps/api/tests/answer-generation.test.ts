import { describe, it, expect } from 'vitest';
import { AiError, createMockAiProvider } from '@jaa/ai';
import {
  buildCandidateContext,
  classifyQuestion,
  computeYearsOfExperience,
  deterministicAnswer,
  generateAnswerForQuestion,
  relevantFacts,
  LENGTH_BUDGETS,
  type CandidateContext,
  type JobContext,
  type QuestionInput,
} from '@jaa/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function q(label: string, fieldType = 'TEXT', options?: { value: string; label: string }[]): QuestionInput {
  return { id: `q-${label.replace(/\W+/g, '-').toLowerCase()}`, label, fieldType, options };
}

function richContext(): CandidateContext {
  return buildCandidateContext({
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
      sponsorshipRequired: true,
      willingToRelocate: true,
      preferredWorkMode: 'REMOTE',
      desiredSalaryMin: 100000,
      desiredSalaryMax: 140000,
      summary: 'Senior engineer focused on distributed systems.',
    },
    experience: [
      {
        title: 'Senior Engineer',
        company: 'Acme Corp',
        startDate: '2019-01-01',
        isCurrent: true,
        description: 'PRIVATE_EXPDESC_MARKER built systems.',
      },
      {
        title: 'Engineer',
        company: 'Beta LLC',
        startDate: '2015-06-01',
        endDate: '2018-12-31',
        description: 'Did things.',
      },
    ],
    education: [
      {
        institution: 'State University',
        degree: 'B.S.',
        fieldOfStudy: 'Computer Science',
        startDate: '2011-09-01',
        endDate: '2015-05-01',
      },
    ],
    skills: [{ name: 'TypeScript' }, { name: 'React' }, { name: 'Node.js' }],
    resume: { extractedText: 'PRIVATE_RESUME_MARKER', parsedData: { skills: ['TypeScript'] } },
  });
}

function emptyContext(): CandidateContext {
  return buildCandidateContext({});
}

const job: JobContext = {
  company: 'InnovateCo',
  title: 'Staff Engineer',
  description: 'Build data platforms.',
  requirements: ['Snowflake', 'dbt'],
  responsibilities: ['Design pipelines'],
  skills: ['SQL'],
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('question classification (deterministic)', () => {
  const cases: [string, string][] = [
    ['Email', 'EMAIL'],
    ['Email Address', 'EMAIL'],
    ['Phone', 'PHONE'],
    ['Phone Number', 'PHONE'],
    ['LinkedIn Profile', 'LINKEDIN'],
    ['GitHub', 'GITHUB'],
    ['Location', 'LOCATION'],
    ['Candidate Location', 'LOCATION'],
    ['Are you authorized to work in the United States?', 'WORK_AUTHORIZATION'],
    [
      'Will you now, or in the future, require sponsorship for an immigration-related employment benefit?',
      'SPONSORSHIP',
    ],
    ['Education', 'EDUCATION'],
    ['Degree', 'EDUCATION'],
    ['University', 'EDUCATION'],
    ['Work Experience', 'EXPERIENCE'],
    ['Employment History', 'EXPERIENCE'],
    ['Relevant Experience', 'EXPERIENCE'],
    ['Skills', 'SKILLS'],
    ['Technical Skills', 'SKILLS'],
    ['Years of Experience', 'YEARS_OF_EXPERIENCE'],
    ['How many years of experience do you have?', 'YEARS_OF_EXPERIENCE'],
    ['What motivates you?', 'MOTIVATION'],
    ['Why do you want to work here?', 'WHY_COMPANY'],
    ['Why are you interested in this role?', 'WHY_ROLE'],
    ['What is your favorite color?', 'OTHER'],
    ['Zorblax', 'OTHER'],
    ['Unknown question', 'OTHER'],
    // Mandated literal label forms
    ['First Name', 'FIRST_NAME'],
    ['Last Name', 'LAST_NAME'],
    ['Full Name', 'FULL_NAME'],
    ['Portfolio', 'PORTFOLIO'],
    ['Work Authorization', 'WORK_AUTHORIZATION'],
    ['Sponsorship', 'SPONSORSHIP'],
    ['Salary', 'SALARY'],
    ['Start Date', 'START_DATE'],
    ['Cover Letter', 'COVER_LETTER'],
    ['Experience Description', 'EXPERIENCE_DESCRIPTION'],
    ['Why Company', 'WHY_COMPANY'],
    ['Why Role', 'WHY_ROLE'],
    ['What is your motivation?', 'MOTIVATION'],
    // Specific rules must win over generic ones
    ['Motivation Letter', 'COVER_LETTER'],
    ['Letter of Motivation', 'COVER_LETTER'],
    ['Preferred First Name', 'PREFERRED_NAME'],
    ['Preferred Location', 'WORK_PREFERENCE'],
    ['Are you willing to relocate?', 'WORK_PREFERENCE'],
    ['Current Location', 'LOCATION'],
    ['Do you require sponsorship?', 'SPONSORSHIP'],
  ];

  for (const [label, expected] of cases) {
    it(`classifies "${label}" -> ${expected}`, () => {
      expect(classifyQuestion(q(label)).category).toBe(expected);
    });
  }

  it('classifies from the adapter semantic tag when present', () => {
    const question: QuestionInput = {
      id: 'sem',
      label: 'some opaque label',
      locator: { attributes: { semantic: 'work_authorization' } },
    };
    expect(classifyQuestion(question).category).toBe('WORK_AUTHORIZATION');
    expect(classifyQuestion(question).matchedBy).toBe('semantic');
  });

  it('maps narrative categories to the AI strategy and unknown to MANUAL', () => {
    expect(classifyQuestion(q('Why do you want to work here?')).strategy).toBe('AI');
    expect(classifyQuestion(q('Cover Letter', 'TEXTAREA')).strategy).toBe('AI');
    expect(classifyQuestion(q('Email')).strategy).toBe('DETERMINISTIC');
    expect(classifyQuestion(q('Something opaque')).strategy).toBe('MANUAL');
  });

  it('never auto-answers file uploads', () => {
    expect(classifyQuestion(q('Cover Letter', 'FILE')).strategy).toBe('MANUAL');
    expect(classifyQuestion(q('Resume', 'FILE')).strategy).toBe('MANUAL');
  });
});

// ---------------------------------------------------------------------------
// Years of experience (interval math)
// ---------------------------------------------------------------------------

describe('years of experience (merged intervals, no double counting)', () => {
  const exp = (startDate: string, endDate?: string, isCurrent = false) => ({
    title: 'Engineer',
    company: 'Acme',
    startDate,
    endDate,
    isCurrent,
  });

  const yearsAnswer = (records: Parameters<typeof buildCandidateContext>[0]) =>
    deterministicAnswer('YEARS_OF_EXPERIENCE', q('Years of Experience'), buildCandidateContext(records));

  it('counts one experience of exactly two calendar years as 2 (not 1)', () => {
    const ctx = buildCandidateContext({
      experience: [exp('2021-01-01', '2023-01-01')],
    });
    expect(computeYearsOfExperience(ctx.experience)).toBeCloseTo(2, 1);
    expect(yearsAnswer({ experience: [exp('2021-01-01', '2023-01-01')] }).answer).toBe('2');
  });

  it('counts an exact three-year span as 3 (not 2)', () => {
    expect(yearsAnswer({ experience: [exp('2021-01-01', '2024-01-01')] }).answer).toBe('3');
  });

  it('sums sequential experiences', () => {
    const records = {
      experience: [exp('2018-01-01', '2020-01-01'), exp('2020-01-01', '2022-01-01')],
    };
    expect(computeYearsOfExperience(records.experience)).toBeCloseTo(4, 1);
    expect(yearsAnswer(records).answer).toBe('4');
  });

  it('does not double count overlapping experiences', () => {
    const records = {
      experience: [exp('2018-01-01', '2021-01-01'), exp('2020-01-01', '2022-01-01')],
    };
    // naive sum would be 6 years; merged span 2018-2022 is 4
    expect(computeYearsOfExperience(records.experience)).toBeCloseTo(4, 1);
    expect(yearsAnswer(records).answer).toBe('4');
  });

  it('ignores zero-length experiences (same start and end dates)', () => {
    const records = {
      experience: [exp('2021-01-01', '2023-01-01'), exp('2022-06-01', '2022-06-01')],
    };
    expect(computeYearsOfExperience(records.experience)).toBeCloseTo(2, 1);
  });

  it('counts a current/present experience up to now', () => {
    const records = { experience: [exp('2025-01-01', undefined, true)] };
    const years = computeYearsOfExperience(records.experience);
    expect(years).not.toBeNull();
    expect(years!).toBeGreaterThan(1);
    expect(years!).toBeLessThan(2);
  });

  it('returns null (no fabricated years) when dates are missing or malformed', () => {
    expect(computeYearsOfExperience([])).toBeNull();
    expect(
      computeYearsOfExperience([exp('not-a-date', '2022-01-01'), exp('', '2022-01-01')])
    ).toBeNull();
    const d = yearsAnswer({ experience: [exp('also-not-a-date')] });
    expect(d.answer).toBeNull();
    expect(d.needsReview).toBe(true);
  });

  it('never counts education as employment experience', () => {
    const records = {
      experience: [exp('2021-01-01', '2023-01-01')],
      education: [
        { institution: 'State U', degree: 'B.S.', startDate: '2011-09-01', endDate: '2015-05-01' },
      ],
    };
    expect(computeYearsOfExperience(records.experience)).toBeCloseTo(2, 1);
    expect(yearsAnswer(records).answer).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// Deterministic answers
// ---------------------------------------------------------------------------

describe('deterministic answers (exact candidate facts)', () => {
  const ctx = richContext();

  it('returns the exact email with PROFILE provenance', () => {
    const d = deterministicAnswer('EMAIL', q('Email'), ctx);
    expect(d.answer).toBe('alice@example.com');
    expect(d.source).toBe('PROFILE');
    expect(d.needsReview).toBe(false);
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
    expect(d.groundedFacts.join(' ')).toContain('alice@example.com');
    expect(d.errorCode).toBeNull();
  });

  it('returns phone, links and location exactly', () => {
    expect(deterministicAnswer('PHONE', q('Phone'), ctx).answer).toBe('+1 555 0100');
    expect(deterministicAnswer('LINKEDIN', q('LinkedIn'), ctx).answer).toBe(
      'https://linkedin.com/in/alice'
    );
    expect(deterministicAnswer('GITHUB', q('GitHub'), ctx).answer).toBe('https://github.com/alice');
    expect(deterministicAnswer('LOCATION', q('Location'), ctx).answer).toBe('San Francisco, CA');
  });

  it('returns names (first, last, full, preferred)', () => {
    expect(deterministicAnswer('FIRST_NAME', q('First Name'), ctx).answer).toBe('Alice');
    expect(deterministicAnswer('LAST_NAME', q('Last Name'), ctx).answer).toBe('Nguyen');
    expect(deterministicAnswer('FULL_NAME', q('Full Name'), ctx).answer).toBe('Alice Nguyen');
    expect(deterministicAnswer('PREFERRED_NAME', q('Preferred Name'), ctx).answer).toBe('Ali');
  });

  it('returns education and skills from stored facts with correct sources', () => {
    const edu = deterministicAnswer('EDUCATION', q('Education'), ctx);
    expect(edu.answer).toContain('State University');
    expect(edu.answer).toContain('B.S.');
    expect(edu.source).toBe('EDUCATION');

    const skills = deterministicAnswer('SKILLS', q('Skills'), ctx);
    expect(skills.answer).toContain('TypeScript');
    expect(skills.answer).toContain('React');
    expect(skills.source).toBe('SKILL');
    expect(skills.needsReview).toBe(false);
  });

  it('computes years of experience from stored dates', () => {
    const d = deterministicAnswer('YEARS_OF_EXPERIENCE', q('Years of Experience'), ctx);
    expect(d.source).toBe('EXPERIENCE');
    expect(d.needsReview).toBe(false);
    const years = parseInt(d.answer ?? '', 10);
    expect(Number.isNaN(years)).toBe(false);
    expect(years).toBeGreaterThanOrEqual(8);
  });

  it('answers work authorization from an explicit status (text + yes/no)', () => {
    const text = deterministicAnswer('WORK_AUTHORIZATION', q('Work Authorization'), ctx);
    expect(text.answer).toContain('US_CITIZEN');
    expect(text.source).toBe('PROFILE');
    expect(text.needsReview).toBe(false);

    const yesNo = deterministicAnswer(
      'WORK_AUTHORIZATION',
      q('Are you authorized to work in the US?', 'RADIO', [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ]),
      ctx
    );
    expect(yesNo.answer).toBe('Yes');
    expect(yesNo.needsReview).toBe(false);
  });

  it('answers sponsorship only on an explicit affirmative', () => {
    const d = deterministicAnswer(
      'SPONSORSHIP',
      q('Will you require sponsorship?', 'RADIO', [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ]),
      ctx
    );
    expect(d.answer).toBe('Yes');
    expect(d.needsReview).toBe(false);
    expect(d.source).toBe('PROFILE');
  });

  it('flags salary as sensitive even when grounded', () => {
    const d = deterministicAnswer('SALARY', q('Desired Salary'), ctx);
    expect(d.answer).toBe('100000 - 140000');
    expect(d.needsReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing facts -> needsReview, never fabricated
// ---------------------------------------------------------------------------

describe('missing facts produce needsReview and never fabricate', () => {
  it('does not invent an email', () => {
    const d = deterministicAnswer('EMAIL', q('Email'), emptyContext());
    expect(d.answer).toBeNull();
    expect(d.needsReview).toBe(true);
    expect(d.confidence).toBeLessThan(0.5);
    expect(d.answer ?? '').not.toContain('@');
  });

  it('does not claim "I do not require sponsorship" when sponsorship is absent', () => {
    const ctx = buildCandidateContext({
      profile: { firstName: 'Bob', lastName: 'Lee', email: 'bob@example.com', sponsorshipRequired: false },
    });
    const d = deterministicAnswer(
      'SPONSORSHIP',
      q('Will you require sponsorship?', 'RADIO', [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ]),
      ctx
    );
    expect(d.needsReview).toBe(true);
    // Must NOT answer "No" / "I do not require sponsorship".
    expect(d.answer).toBeNull();
    expect((d.answer ?? '').toLowerCase()).not.toContain('do not require');
  });

  it('does not invent work authorization when status is unset (OTHER)', () => {
    const ctx = buildCandidateContext({
      profile: { firstName: 'Bob', lastName: 'Lee', email: 'bob@example.com', workAuthorization: 'OTHER' },
    });
    const d = deterministicAnswer('WORK_AUTHORIZATION', q('Work Authorization'), ctx);
    expect(d.needsReview).toBe(true);
    expect(d.answer).toBeNull();
  });

  it('does not invent start date / notice period', () => {
    const ctx = richContext();
    expect(deterministicAnswer('START_DATE', q('When can you start?'), ctx).needsReview).toBe(true);
    expect(deterministicAnswer('NOTICE_PERIOD', q('Notice period'), ctx).answer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AI answers (mocked)
// ---------------------------------------------------------------------------

describe('AI answers (mocked provider)', () => {
  it('prompts with facts, job context and anti-fabrication, and persists provenance', async () => {
    const mock = createMockAiProvider({ defaultText: 'I want to build data platforms like my work at Acme Corp.' });
    const ctx = richContext();
    const d = await generateAnswerForQuestion(q('Why do you want to work here?', 'TEXTAREA'), ctx, {
      aiProvider: mock,
      job,
    });

    const prompt = mock.prompts[0];
    // relevant candidate facts
    expect(prompt).toContain('Acme Corp');
    // job context
    expect(prompt).toContain('InnovateCo');
    expect(prompt).toContain('Staff Engineer');
    // anti-fabrication
    expect(prompt.toLowerCase()).toContain('do not invent');
    expect(prompt.toLowerCase()).toContain('fabricate');
    expect(prompt).toContain('NEEDS_REVIEW');

    // provenance persisted on the draft
    expect(d.source).toBe('AI');
    expect(d.answer).toContain('Acme Corp');
    expect(d.needsReview).toBe(true);
    expect(d.confidence).toBeGreaterThan(0);
    expect(d.confidence).toBeLessThanOrEqual(1);
    expect(d.groundedFacts.length).toBeGreaterThan(0);
    expect(d.errorCode).toBeNull();
  });

  it('does not call the model and flags review when facts are insufficient', async () => {
    const mock = createMockAiProvider();
    const d = await generateAnswerForQuestion(q('Why do you want to work here?', 'TEXTAREA'), emptyContext(), {
      aiProvider: mock,
      job,
    });
    expect(mock.calls).toHaveLength(0);
    expect(d.needsReview).toBe(true);
    expect(d.answer).toBeNull();
    expect(d.reviewReason).toBe('INSUFFICIENT_FACTS');
    expect(d.errorCode).toBeNull();
  });

  it('excludes unrelated candidate data from question-specific AI context', async () => {
    const mock = createMockAiProvider({ defaultText: 'Grounded answer.' });
    const ctx = richContext();
    await generateAnswerForQuestion(q('Why do you want to work here?', 'TEXTAREA'), ctx, {
      aiProvider: mock,
      job,
    });
    const prompt = mock.prompts[0];
    // contact info must not be sent to a WHY_COMPANY question
    expect(prompt).not.toContain('alice@example.com');
    expect(prompt).not.toContain('+1 555 0100');
    expect(prompt).not.toContain('https://linkedin.com/in/alice');
    // raw experience description + raw resume text are not sent
    expect(prompt).not.toContain('PRIVATE_EXPDESC_MARKER');
    expect(prompt).not.toContain('PRIVATE_RESUME_MARKER');
  });

  it('a LinkedIn question uses only the LinkedIn fact (no whole resume)', async () => {
    const mock = createMockAiProvider();
    const ctx = richContext();
    const d = await generateAnswerForQuestion(q('LinkedIn Profile'), ctx, { aiProvider: mock, job });
    // deterministic - the model is never called
    expect(mock.calls).toHaveLength(0);
    expect(d.answer).toBe('https://linkedin.com/in/alice');
    expect(d.source).toBe('PROFILE');
  });

  it('instructs a length budget and truncates cleanly as safety', async () => {
    const longText = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const mock = createMockAiProvider({ defaultText: longText });
    const ctx = richContext();
    const d = await generateAnswerForQuestion(q('Why do you want to work here?', 'TEXTAREA'), ctx, {
      aiProvider: mock,
      job,
    });
    expect(mock.prompts[0]).toContain('Keep the answer under');
    const budget = LENGTH_BUDGETS.medium.chars;
    expect((d.answer ?? '').length).toBeLessThanOrEqual(budget);
    // cover letter is a long field -> larger budget requested
    const mock2 = createMockAiProvider({ defaultText: longText });
    await generateAnswerForQuestion(q('Cover Letter', 'TEXTAREA'), ctx, { aiProvider: mock2, job });
    expect(mock2.prompts[0]).toContain(`${LENGTH_BUDGETS.long.words} words`);
  });
});

// ---------------------------------------------------------------------------
// AI failure handling
// ---------------------------------------------------------------------------

describe('AI failure handling', () => {
  const ctx = richContext();
  const question = q('Why do you want to work here?', 'TEXTAREA');

  async function failing(handler: () => string | Promise<string>) {
    const mock = createMockAiProvider({ handler });
    return generateAnswerForQuestion(question, ctx, { aiProvider: mock, job });
  }

  it('maps a timeout to a structured error and needsReview', async () => {
    const d = await failing(() => {
      throw new AiError('AI_TIMEOUT', 'timed out');
    });
    expect(d.errorCode).toBe('AI_TIMEOUT');
    expect(d.needsReview).toBe(true);
    expect(d.answer).toBeNull();
  });

  it('maps a provider failure to a structured error', async () => {
    const d = await failing(() => {
      throw new AiError('AI_RATE_LIMITED', 'slow down');
    });
    expect(d.errorCode).toBe('AI_RATE_LIMITED');
    expect(d.needsReview).toBe(true);
    expect(d.answer).toBeNull();
  });

  it('maps a generic failure to AI_REQUEST_FAILED', async () => {
    const d = await failing(() => {
      throw new Error('boom');
    });
    expect(d.errorCode).toBe('AI_REQUEST_FAILED');
    expect(d.needsReview).toBe(true);
    expect(d.answer).toBeNull();
  });

  it('treats an empty response as a failure', async () => {
    const d = await failing(() => '   ');
    expect(d.errorCode).toBe('AI_EMPTY_RESPONSE');
    expect(d.needsReview).toBe(true);
    expect(d.answer).toBeNull();
  });

  it('treats invalid structured output as a failure', async () => {
    const d = await failing(() => {
      throw new AiError('AI_INVALID_RESPONSE', 'malformed');
    });
    expect(d.errorCode).toBe('AI_INVALID_RESPONSE');
    expect(d.needsReview).toBe(true);
    expect(d.answer).toBeNull();
  });

  it('treats a missing provider as AI_PROVIDER_UNAVAILABLE', async () => {
    const d = await generateAnswerForQuestion(question, ctx, { aiProvider: null, job });
    expect(d.errorCode).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(d.needsReview).toBe(true);
    expect(d.answer).toBeNull();
  });

  it('honours the model NEEDS_REVIEW sentinel without inventing', async () => {
    const d = await failing(() => 'NEEDS_REVIEW');
    expect(d.needsReview).toBe(true);
    expect(d.answer).toBeNull();
    expect(d.errorCode).toBeNull();
    expect(d.reviewReason).toBe('MODEL_REQUESTED_REVIEW');
  });
});

// ---------------------------------------------------------------------------
// Privacy scoping (relevantFacts)
// ---------------------------------------------------------------------------

describe('privacy: per-category fact scoping', () => {
  const ctx = richContext();

  it('scopes LinkedIn to only the LinkedIn fact', () => {
    const keys = relevantFacts('LINKEDIN', ctx).map((f) => f.key);
    expect(keys).toEqual(['linkedin']);
  });

  it('scopes work authorization to only work authorization', () => {
    const keys = relevantFacts('WORK_AUTHORIZATION', ctx).map((f) => f.key);
    expect(keys).toEqual(['work_authorization']);
  });

  it('excludes contact info from narrative/AI categories', () => {
    const keys = relevantFacts('WHY_ROLE', ctx).map((f) => f.key);
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('phone');
    expect(keys).not.toContain('linkedin');
  });
});
