import { describe, it, expect } from 'vitest';
import {
  buildReviewSections,
  changedSectionsOf,
  isReviewableVersion,
  reviewStateOf,
  safeProvenanceOf,
  HUMAN_EDIT_STRATEGY,
  type ReviewResumeContent,
} from '@jaa/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAILORED_PROVENANCE = {
  sourceVersionId: 'ver-1',
  jobId: 'job-1',
  strategy: 'JOB_ALIGNED_V1',
  aiGenerated: true,
  provider: 'mock',
  model: 'mock-1',
  validationStatus: 'PASSED',
  contentFormat: 'STRUCTURED_JSON',
  promptVersion: 'v1',
  generatedAt: '2026-10-03T10:00:00.000Z',
};

const HUMAN_EDIT_PROVENANCE = {
  sourceVersionId: 'ver-2',
  jobId: 'job-1',
  strategy: HUMAN_EDIT_STRATEGY,
  aiGenerated: false,
  editedBy: 'user-1',
  validationStatus: 'PASSED',
  contentFormat: 'STRUCTURED_JSON',
  generatedAt: '2026-10-03T11:00:00.000Z',
};

function sections(overrides: Partial<ReviewResumeContent> = {}): ReviewResumeContent {
  return {
    summary: 'Senior engineer focused on distributed systems.',
    skills: ['SQL', 'Python'],
    experience: [
      {
        company: 'Acme Corp',
        title: 'Senior Engineer',
        startDate: '2019-01',
        endDate: null,
        isCurrent: true,
        bullets: ['Built data pipelines with SQL and Python'],
      },
    ],
    education: [
      {
        institution: 'State University',
        degree: 'Bachelor of Science',
        fieldOfStudy: 'Computer Science',
        details: [],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Review eligibility
// ---------------------------------------------------------------------------

describe('review eligibility', () => {
  it('accepts a validated TAILORED version', () => {
    expect(
      isReviewableVersion({ source: 'TAILORED', tailoring: TAILORED_PROVENANCE })
    ).toBe(true);
  });

  it('accepts a validated USER_EDITED (human edit) version', () => {
    expect(
      isReviewableVersion({ source: 'USER_EDITED', tailoring: HUMAN_EDIT_PROVENANCE })
    ).toBe(true);
  });

  it('rejects an ORIGINAL version even if someone forged tailoring metadata on it', () => {
    expect(isReviewableVersion({ source: 'ORIGINAL', tailoring: TAILORED_PROVENANCE })).toBe(false);
  });

  it('rejects a version without tailoring metadata', () => {
    expect(isReviewableVersion({ source: 'TAILORED', tailoring: null })).toBe(false);
    expect(isReviewableVersion({ source: 'TAILORED' })).toBe(false);
    expect(isReviewableVersion({ source: 'TAILORED', tailoring: [] })).toBe(false);
  });

  it('rejects failed or invalid tailoring (validationStatus must be PASSED)', () => {
    expect(
      isReviewableVersion({
        source: 'TAILORED',
        tailoring: { ...TAILORED_PROVENANCE, validationStatus: 'FAILED' },
      })
    ).toBe(false);
    expect(
      isReviewableVersion({
        source: 'TAILORED',
        tailoring: { ...TAILORED_PROVENANCE, validationStatus: 'PENDING' },
      })
    ).toBe(false);
  });

  it('rejects incomplete provenance (missing source version or job)', () => {
    expect(
      isReviewableVersion({
        source: 'TAILORED',
        tailoring: { ...TAILORED_PROVENANCE, sourceVersionId: '' },
      })
    ).toBe(false);
    expect(
      isReviewableVersion({
        source: 'TAILORED',
        tailoring: { ...TAILORED_PROVENANCE, jobId: undefined },
      })
    ).toBe(false);
    expect(
      isReviewableVersion({
        source: 'TAILORED',
        tailoring: { ...TAILORED_PROVENANCE, strategy: undefined },
      })
    ).toBe(false);
  });

  it('rejects other sources (IMPORTED, AI_GENERATED)', () => {
    expect(isReviewableVersion({ source: 'IMPORTED', tailoring: TAILORED_PROVENANCE })).toBe(false);
    expect(isReviewableVersion({ source: 'AI_GENERATED', tailoring: TAILORED_PROVENANCE })).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// Safe provenance
// ---------------------------------------------------------------------------

describe('safeProvenanceOf', () => {
  it('exposes only the whitelisted safe metadata', () => {
    const safe = safeProvenanceOf(TAILORED_PROVENANCE)!;
    expect(safe).toEqual({
      sourceVersionId: 'ver-1',
      jobId: 'job-1',
      strategy: 'JOB_ALIGNED_V1',
      aiGenerated: true,
      provider: 'mock',
      model: 'mock-1',
      validationStatus: 'PASSED',
      contentFormat: 'STRUCTURED_JSON',
      promptVersion: 'v1',
      generatedAt: '2026-10-03T10:00:00.000Z',
    });
  });

  it('never leaks prompts, secrets, or unknown keys from the stored JSON', () => {
    const safe = safeProvenanceOf({
      ...TAILORED_PROVENANCE,
      prompt: 'SYSTEM PROMPT WITH SECRETS',
      apiKey: 'sk-123',
      resumeText: 'PII resume content',
      rawAudit: { internal: true },
    })!;
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('SYSTEM PROMPT');
    expect(serialized).not.toContain('sk-123');
    expect(serialized).not.toContain('PII resume content');
    expect(serialized).not.toContain('rawAudit');
    expect(Object.keys(safe).sort()).toEqual([
      'aiGenerated',
      'contentFormat',
      'generatedAt',
      'jobId',
      'model',
      'promptVersion',
      'provider',
      'sourceVersionId',
      'strategy',
      'validationStatus',
    ]);
  });

  it('marks human-edited provenance', () => {
    const safe = safeProvenanceOf(HUMAN_EDIT_PROVENANCE)!;
    expect(safe.aiGenerated).toBe(false);
    expect(safe.humanEdited).toBe(true);
    expect(safe.strategy).toBe(HUMAN_EDIT_STRATEGY);
  });

  it('returns null when there is no provenance', () => {
    expect(safeProvenanceOf(null)).toBeNull();
    expect(safeProvenanceOf('nonsense')).toBeNull();
    expect(safeProvenanceOf([1, 2])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section normalization and comparison
// ---------------------------------------------------------------------------

describe('buildReviewSections', () => {
  it('normalizes ParsedProfile-shaped data into review sections', () => {
    const content = buildReviewSections({
      summary: 'Senior engineer.',
      skills: ['SQL', 'Python'],
      experience: [
        {
          company: 'Acme Corp',
          title: 'Senior Engineer',
          startDate: '2019-01',
          endDate: null,
          isCurrent: true,
          description: 'Built data pipelines with SQL and Python.\n- Reduced report time by 50%',
        },
      ],
      education: [
        {
          institution: 'State University',
          degree: 'Bachelor of Science',
          fieldOfStudy: 'Computer Science',
          description: 'Honors',
        },
      ],
    });

    expect(content.summary).toBe('Senior engineer.');
    expect(content.skills).toEqual(['SQL', 'Python']);
    expect(content.experience).toEqual([
      {
        company: 'Acme Corp',
        title: 'Senior Engineer',
        startDate: '2019-01',
        endDate: null,
        isCurrent: true,
        bullets: ['Built data pipelines with SQL and Python.', 'Reduced report time by 50%'],
      },
    ]);
    expect(content.education[0].details).toEqual(['Honors']);
  });

  it('prefers structured bullets over the description text', () => {
    const content = buildReviewSections({
      experience: [
        {
          company: 'Acme Corp',
          title: 'Senior Engineer',
          description: 'ignored',
          bullets: ['Structured bullet'],
        },
      ],
    });
    expect(content.experience[0].bullets).toEqual(['Structured bullet']);
  });

  it('returns empty sections for missing or malformed data', () => {
    for (const input of [null, undefined, 'x', 42, [], {}]) {
      const content = buildReviewSections(input);
      expect(content).toEqual({
        summary: null,
        skills: [],
        experience: [],
        education: [],
      });
    }
  });
});

describe('changedSectionsOf', () => {
  it('flags only the sections that differ', () => {
    const source = sections();
    const tailored = sections({
      summary: 'Rephrased summary.',
      experience: [
        {
          ...source.experience[0],
          bullets: ['Rephrased bullet'],
        },
      ],
    });
    expect(changedSectionsOf(source, tailored).sort()).toEqual(['experience', 'summary']);
  });

  it('returns nothing for identical content', () => {
    expect(changedSectionsOf(sections(), sections())).toEqual([]);
  });

  it('flags removals as changes', () => {
    const source = sections();
    const tailored = sections({ skills: [] });
    expect(changedSectionsOf(source, tailored)).toEqual(['skills']);
  });
});

// ---------------------------------------------------------------------------
// Review state
// ---------------------------------------------------------------------------

describe('reviewStateOf', () => {
  it('defaults to PENDING with no reviewer or note', () => {
    expect(reviewStateOf({ id: 'v1' })).toEqual({
      reviewStatus: 'PENDING',
      reviewedAt: null,
      reviewedBy: null,
      reviewNotes: null,
    });
  });

  it('normalizes timestamps to ISO strings', () => {
    const state = reviewStateOf({
      id: 'v1',
      reviewStatus: 'REJECTED',
      reviewedAt: new Date('2026-10-03T12:00:00.000Z'),
      reviewedBy: 'user-1',
      reviewNotes: 'Wrong tone',
    });
    expect(state.reviewStatus).toBe('REJECTED');
    expect(state.reviewedAt).toBe('2026-10-03T12:00:00.000Z');
    expect(state.reviewedBy).toBe('user-1');
    expect(state.reviewNotes).toBe('Wrong tone');
  });
});
