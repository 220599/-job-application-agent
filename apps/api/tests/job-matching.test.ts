import { describe, it, expect } from 'vitest';
import {
  computeJobMatch,
  normalizeSkill,
  type MatchInput,
  type MatchProfileInput,
  type MatchSkillInput,
  type MatchExperienceInput,
} from '../src/services/job-matching-core';

/**
 * Realistic fixtures shaped after the Prisma schema (CandidateProfile,
 * Skill, Experience, Job). All matching tests run against these.
 */

const baseProfile: MatchProfileInput = {
  workAuthorization: 'US_CITIZEN',
  sponsorshipRequired: false,
  willingToRelocate: true,
  preferredWorkMode: 'REMOTE',
  preferredLocations: ['San Francisco', 'New York'],
  desiredRoles: ['Software Engineer', 'Backend Engineer'],
  desiredSalaryMin: 120000,
  desiredSalaryMax: 180000,
  city: 'Austin',
  state: 'TX',
  country: 'United States',
};

const baseSkills: MatchSkillInput[] = [
  { name: 'Python', proficiency: 'EXPERT', yearsOfExperience: 5 },
  { name: 'PostgreSQL', proficiency: 'ADVANCED', yearsOfExperience: 4 },
  { name: 'AWS', proficiency: 'INTERMEDIATE', yearsOfExperience: 3 },
  { name: 'React', proficiency: 'INTERMEDIATE', yearsOfExperience: 3 },
  { name: 'Docker', proficiency: 'INTERMEDIATE', yearsOfExperience: 2 },
];

const baseExperience: MatchExperienceInput[] = [
  {
    company: 'Acme Corp',
    title: 'Software Engineer',
    employmentType: 'FULL_TIME',
    isCurrent: true,
    description:
      'Built backend services with Python, FastAPI and PostgreSQL deployed on AWS using Docker and CI/CD pipelines.',
  },
  {
    company: 'Beta LLC',
    title: 'Junior Developer',
    employmentType: 'FULL_TIME',
    isCurrent: false,
    description: 'Frontend development with React and JavaScript.',
  },
];

const strongJob = {
  title: 'Senior Software Engineer',
  company: 'TechCo',
  location: 'Remote',
  description: 'Join our platform team building scalable services.',
  employmentType: 'FULL_TIME',
  workMode: 'REMOTE',
  salaryMin: 130000,
  salaryMax: 190000,
  salaryCurrency: 'USD',
  requirements: [
    '5+ years of Python experience',
    'Experience with PostgreSQL',
    'Experience with Kubernetes in production',
  ],
  skills: ['Python', 'PostgreSQL', 'AWS', 'Kubernetes'],
};

function buildInput(overrides?: {
  job?: Partial<typeof strongJob>;
  profile?: Partial<MatchProfileInput>;
  skills?: MatchSkillInput[];
  experience?: MatchExperienceInput[];
}): MatchInput {
  return {
    job: { ...strongJob, ...overrides?.job },
    profile: { ...baseProfile, ...overrides?.profile },
    skills: overrides?.skills ?? baseSkills,
    experience: overrides?.experience ?? baseExperience,
  };
}

const factorOf = (input: MatchInput, key: string) =>
  computeJobMatch(input).factors.find((f) => f.key === key)!;

describe('normalizeSkill', () => {
  it('normalizes case and common variations', () => {
    expect(normalizeSkill('Python')).toBe('python');
    expect(normalizeSkill('Postgres')).toBe(normalizeSkill('PostgreSQL'));
    expect(normalizeSkill('aws')).toBe(normalizeSkill('Amazon Web Services'));
    expect(normalizeSkill('Node.js')).toBe(normalizeSkill('NodeJS'));
    expect(normalizeSkill('K8s')).toBe(normalizeSkill('Kubernetes'));
  });
});

describe('computeJobMatch', () => {
  it('1. strong skill match: high overall with matched/missing skills reported', () => {
    const result = computeJobMatch(buildInput());
    expect(result.overallScore).toBeGreaterThanOrEqual(80);
    expect(factorOf(buildInput(), 'skills').score).toBe(75); // 3 of 4 job skills matched
    expect(factorOf(buildInput(), 'skills').status).toBe('MET');
    expect(result.matchedSkills).toEqual(expect.arrayContaining(['Python', 'PostgreSQL', 'AWS']));
    expect(result.missingSkills).toEqual(['Kubernetes']);
  });

  it('2. weak skill match: zero skill score but not a zero overall score', () => {
    const job = {
      title: 'Salesforce Administrator',
      skills: ['Kubernetes', 'Terraform', 'Rust', 'GraphQL'],
      requirements: ['Kubernetes administration', 'Terraform IaC', 'Rust development'],
    };
    const input = buildInput({ job });
    const skills = factorOf(input, 'skills');
    expect(skills.score).toBe(0);
    expect(skills.status).toBe('UNMET');
    const result = computeJobMatch(input);
    expect(result.overallScore).toBeGreaterThan(0);
    expect(result.overallScore).toBeLessThan(50);
  });

  it('3. exact role match scores 100', () => {
    const role = factorOf(buildInput({ job: { title: 'Software Engineer' } }), 'role');
    expect(role.score).toBe(100);
    expect(role.status).toBe('MET');
  });

  it('4. different but related role gets partial credit', () => {
    // "Data Engineer" shares the "engineer" token with desired "Software Engineer"
    const role = factorOf(buildInput({ job: { title: 'Data Engineer' } }), 'role');
    expect(role.score).toBe(75);
    expect(role.status).toBe('MET');
    // Seniority words are ignored: "Senior Software Engineer" is an exact match
    const senior = factorOf(buildInput({ job: { title: 'Senior Software Engineer' } }), 'role');
    expect(senior.score).toBe(100);
  });

  it('5. remote job + remote preference scores 100 on location', () => {
    const location = factorOf(buildInput(), 'location');
    expect(location.score).toBe(100);
    expect(location.matched).toContain('Remote work');
  });

  it('6. location mismatch: on-site job far from preferences and no relocation', () => {
    const job = {
      workMode: 'ONSITE',
      location: 'Denver, Colorado',
    };
    const profile = { willingToRelocate: false };
    const location = factorOf(buildInput({ job, profile }), 'location');
    expect(location.score).not.toBeNull();
    expect(location.score!).toBeLessThanOrEqual(30);
    expect(location.status).toBe('UNMET');
    expect(location.missing.join(' ')).toContain('Denver');
  });

  it('7. salary overlap scores 100', () => {
    const salary = factorOf(buildInput(), 'salary'); // job 130k-190k vs desired 120k-180k
    expect(salary.score).toBe(100);
    expect(salary.status).toBe('MET');
  });

  it('8. missing job salary is NOT_APPLICABLE and never zeroes the overall score', () => {
    const job = { salaryMin: null, salaryMax: null, salaryCurrency: 'USD' };
    const input = buildInput({ job: job as any });
    const salary = factorOf(input, 'salary');
    expect(salary.score).toBeNull();
    expect(salary.status).toBe('NOT_APPLICABLE');
    const result = computeJobMatch(input);
    expect(result.overallScore).toBeGreaterThan(50);
  });

  it('9. missing job skills is NOT_APPLICABLE with weight redistributed', () => {
    const job = { skills: null, requirements: null };
    const input = buildInput({ job: job as any });
    const skills = factorOf(input, 'skills');
    expect(skills.score).toBeNull();
    expect(skills.status).toBe('NOT_APPLICABLE');
    const result = computeJobMatch(input);
    expect(result.overallScore).toBeGreaterThan(0);
    expect(result.matchedSkills).toEqual([]);
    expect(result.missingSkills).toEqual([]);
  });

  it('10. missing candidate skills: honest zero with a clear concern', () => {
    const input = buildInput({ skills: [] });
    const skills = factorOf(input, 'skills');
    expect(skills.score).toBe(0);
    expect(skills.notes.join(' ')).toMatch(/no skills listed/i);
    const result = computeJobMatch(input);
    expect(result.concerns.join(' ')).toMatch(/no skills listed/i);
  });

  it('11. missing optional job data: score computed from the factors that DO apply', () => {
    const job = {
      title: 'Backend Engineer',
      company: 'SparseCo',
      location: null,
      description: null,
      employmentType: null,
      workMode: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: 'USD',
      requirements: null,
      skills: null,
    };
    const input = buildInput({ job: job as any });
    const result = computeJobMatch(input);
    // Only the role factor is applicable (desired role "Backend Engineer" matches exactly)
    expect(result.factors.find((f) => f.key === 'skills')!.status).toBe('NOT_APPLICABLE');
    expect(result.factors.find((f) => f.key === 'experience')!.status).toBe('NOT_APPLICABLE');
    expect(result.factors.find((f) => f.key === 'location')!.status).toBe('NOT_APPLICABLE');
    expect(result.factors.find((f) => f.key === 'salary')!.status).toBe('NOT_APPLICABLE');
    expect(result.overallScore).toBe(100);
    expect(result.explanation).toContain('Strong match');
  });

  it('12. no fabricated candidate information: only stored data is used as evidence', () => {
    const job = {
      title: 'Platform Engineer',
      skills: ['Kubernetes', 'Terraform'],
      requirements: ['Kubernetes cluster administration', 'Terraform infrastructure as code'],
    };
    // Candidate works in sales support - none of the job skills exist on the profile.
    const experience: MatchExperienceInput[] = [
      {
        company: 'SalesCo',
        title: 'Sales Support Specialist',
        employmentType: 'FULL_TIME',
        isCurrent: true,
        description: 'Managed CRM pipelines and customer onboarding.',
      },
    ];
    const input = buildInput({ job, experience });
    const result = computeJobMatch(input);

    expect(result.matchedSkills).toEqual([]);
    expect(result.missingSkills).toEqual(expect.arrayContaining(['Kubernetes', 'Terraform']));

    const exp = factorOf(input, 'experience');
    expect(exp.score).toBe(0);
    expect(exp.matched).toEqual([]);
    // The engine must not invent evidence: gaps only reference real stored data or job data.
    expect(result.gaps.join(' ')).toContain('Kubernetes');
    // Explanation must not claim skills the candidate does not have.
    expect(result.explanation).not.toMatch(/matched \(Kubernetes/);
  });

  it('is deterministic: identical inputs produce identical output', () => {
    const a = computeJobMatch(buildInput());
    const b = computeJobMatch(buildInput());
    expect(a).toEqual(b);
  });

  it('never returns scores outside 0-100', () => {
    const result = computeJobMatch(buildInput());
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
    for (const f of result.factors) {
      if (f.score !== null) {
        expect(f.score).toBeGreaterThanOrEqual(0);
        expect(f.score).toBeLessThanOrEqual(100);
      }
    }
  });
});
