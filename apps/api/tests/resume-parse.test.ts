import { describe, it, expect } from 'vitest';
import { parseResumeText, parseDateToken } from '../src/services/resume-parse';

const RESUME_TEXT = `Jordan A. Smith
Austin, TX 78701 | (512) 555-0199 | jordan.smith@example.com
linkedin.com/in/jordansmith | github.com/jordansmith

SUMMARY
Backend-focused software engineer with 6 years building distributed systems.

SKILLS
Languages: Python, TypeScript, Java, Go
Frameworks: React, FastAPI, Django
Tools: AWS, Docker, Kubernetes, PostgreSQL, Redis

EXPERIENCE
Senior Software Engineer - TechCorp (March 2021 - Present)
- Led migration of monolith to microservices on AWS and Kubernetes
- Built event pipelines with Python and Kafka serving 2M requests/day

Software Developer - DataWorks (Jun 2018 - Feb 2021)
- Developed REST APIs with Django and PostgreSQL
- Automated deployments with Docker and CI/CD

EDUCATION
B.S. Computer Science - University of Texas (2014 - 2018)
M.S. Data Science - Georgia Tech (2018 - 2020)
`;

describe('parseDateToken', () => {
  it('parses month names, slashes, and bare years', () => {
    expect(parseDateToken('March 2020')).toBe('2020-03');
    expect(parseDateToken('Sept 2019')).toBe('2019-09');
    expect(parseDateToken('05/2019')).toBe('2019-05');
    expect(parseDateToken('2019')).toBe('2019');
    expect(parseDateToken('nonsense')).toBeNull();
  });
});

describe('parseResumeText', () => {
  const parsed = parseResumeText(RESUME_TEXT);

  it('extracts name from the header', () => {
    expect(parsed.firstName).toBe('Jordan');
    expect(parsed.lastName).toBe('Smith');
  });

  it('extracts contact details', () => {
    expect(parsed.email).toBe('jordan.smith@example.com');
    expect(parsed.phone).toContain('(512) 555-0199');
    expect(parsed.linkedinUrl).toContain('linkedin.com/in/jordansmith');
    expect(parsed.githubUrl).toContain('github.com/jordansmith');
    expect(parsed.location).toContain('Austin');
  });

  it('extracts skills from the skills section', () => {
    expect(parsed.skills).toEqual(
      expect.arrayContaining(['Python', 'TypeScript', 'AWS', 'Docker', 'Kubernetes', 'PostgreSQL'])
    );
    // Not from other sections
    expect(parsed.skills).not.toContain('SUMMARY');
  });

  it('extracts summary', () => {
    expect(parsed.summary).toContain('6 years');
  });

  it('extracts two experience entries with dates and companies', () => {
    expect(parsed.experience).toHaveLength(2);
    const first = parsed.experience[0];
    expect(first.title).toContain('Senior Software Engineer');
    expect(first.company).toContain('TechCorp');
    expect(first.startDate).toBe('2021-03');
    expect(first.isCurrent).toBe(true);
    expect(first.description).toContain('microservices');
    const second = parsed.experience[1];
    expect(second.company).toContain('DataWorks');
    expect(second.isCurrent).toBe(false);
  });

  it('extracts education entries', () => {
    expect(parsed.education.length).toBeGreaterThanOrEqual(2);
    const bs = parsed.education[0];
    expect(bs.degree.toLowerCase()).toMatch(/^b\.?s\.?/);
    expect(bs.institution).toContain('University of Texas');
  });

  it('handles a resume with no recognizable sections gracefully', () => {
    const sparse = parseResumeText('Jane Doe\njane@doe.com');
    expect(sparse.firstName).toBe('Jane');
    expect(sparse.skills).toEqual([]);
    expect(sparse.experience).toEqual([]);
    expect(sparse.education).toEqual([]);
  });

  it('is deterministic', () => {
    expect(parseResumeText(RESUME_TEXT)).toEqual(parsed);
  });
});
