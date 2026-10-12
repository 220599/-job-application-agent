/**
 * Phase 15B.2 - Job Board API orchestration glue tests.
 *
 * Pure unit tests (no network, no fixtures needed) plus one loopback
 * connection-refused probe for the pre-transmission failure class.
 *
 * Proven here:
 *  - the documented `/{board_token}/jobs/{id}` URL shape is parsed, and any
 *    other shape yields "API path unavailable" (never a guessed token);
 *  - path selection is SERVER-SIDE only (env + URL + mode), the fallback to
 *    the form path is never silent, and a mock run can never reach the real
 *    API (loopback fixture base required);
 *  - prepared answers map onto documented field names only - built-in
 *    semantics, exact normalized label matches, documented option values;
 *    anything ambiguous or unmatched is never guessed and blocks required
 *    questions;
 *  - a connection that was never established is a KNOWN pre-transmission
 *    failure (SUBMISSION_FAILED), while any ambiguous network failure stays
 *    UNKNOWN (SUBMISSION_UNCONFIRMED).
 */

import { createServer } from 'net';

import { describe, it, expect } from 'vitest';
import { isAtsError, type AtsFieldFill } from '@jaa/ats';

import {
  isDefinitelyNotTransmitted,
  submitGreenhouseJobBoardApplication,
  type GreenhouseJobBoardQuestion,
} from '../src/job-board-api';
import {
  buildGreenhouseJobBoardInput,
  parseGreenhouseJobBoardTarget,
  resolveGreenhouseJobBoardApiConfig,
  selectGreenhouseSubmissionPath,
} from '../src/job-board-submission';

function fill(partial: Partial<AtsFieldFill> & { value: string }): AtsFieldFill {
  return {
    questionId: 'q-1',
    fieldType: 'TEXT',
    locator: null,
    required: true,
    options: null,
    label: null,
    externalFieldId: null,
    ...partial,
  };
}

describe('parseGreenhouseJobBoardTarget', () => {
  it('parses the documented job-board URL shape', () => {
    expect(
      parseGreenhouseJobBoardTarget('https://job-boards.greenhouse.io/very_awesome_inc/jobs/127817')
    ).toEqual({ boardToken: 'very_awesome_inc', jobPostId: '127817' });
    expect(
      parseGreenhouseJobBoardTarget('https://boards.greenhouse.io/vaulttec/jobs/44444/application')
    ).toEqual({ boardToken: 'vaulttec', jobPostId: '44444' });
    expect(parseGreenhouseJobBoardTarget('http://127.0.0.1:9123/test-board/jobs/127817')).toEqual({
      boardToken: 'test-board',
      jobPostId: '127817',
    });
  });

  it('never invents a target for other URL shapes', () => {
    expect(parseGreenhouseJobBoardTarget('https://job-boards.greenhouse.io/vaulttec')).toBeNull();
    expect(parseGreenhouseJobBoardTarget('https://job-boards.greenhouse.io/embed/job_app')).toBeNull();
    expect(
      parseGreenhouseJobBoardTarget('https://jobs.example.com/careers/127817')
    ).toBeNull();
    expect(parseGreenhouseJobBoardTarget('not a url')).toBeNull();
    expect(
      parseGreenhouseJobBoardTarget('https://user:pass@job-boards.greenhouse.io/x/jobs/1')
    ).toBeNull();
    expect(
      parseGreenhouseJobBoardTarget('https://job-boards.greenhouse.io/x/jobs/not-a-number')
    ).toBeNull();
  });
});

describe('resolveGreenhouseJobBoardApiConfig', () => {
  it('is null without an employer-issued key (fail-safe: API path unavailable)', () => {
    expect(resolveGreenhouseJobBoardApiConfig({})).toBeNull();
    expect(resolveGreenhouseJobBoardApiConfig({ JAA_GREENHOUSE_JOB_BOARD_API_KEY: '   ' })).toBeNull();
  });

  it('reads the key and the test-only base override from the server environment', () => {
    expect(
      resolveGreenhouseJobBoardApiConfig({ JAA_GREENHOUSE_JOB_BOARD_API_KEY: 'employer-key' })
    ).toEqual({ apiKey: 'employer-key' });
    expect(
      resolveGreenhouseJobBoardApiConfig({
        JAA_GREENHOUSE_JOB_BOARD_API_KEY: 'employer-key',
        JAA_GREENHOUSE_JOB_BOARD_API_BASE: 'http://127.0.0.1:9999',
      })
    ).toEqual({ apiKey: 'employer-key', baseUrl: 'http://127.0.0.1:9999' });
  });
});

describe('selectGreenhouseSubmissionPath', () => {
  const ENV_WITH_KEY = { JAA_GREENHOUSE_JOB_BOARD_API_KEY: 'employer-key' };
  const ENV_WITH_KEY_AND_FIXTURE = {
    JAA_GREENHOUSE_JOB_BOARD_API_KEY: 'test-key',
    JAA_GREENHOUSE_JOB_BOARD_API_BASE: 'http://127.0.0.1:9999',
  };
  const URL_OK = 'https://job-boards.greenhouse.io/vaulttec/jobs/127817';

  it('selects the Job Board API when the employer key and URL shape permit it (REAL)', () => {
    const selection = selectGreenhouseSubmissionPath({
      url: URL_OK,
      submissionMode: 'REAL',
      env: ENV_WITH_KEY,
    });
    expect(selection.path).toBe('JOB_BOARD_API');
  });

  it('falls back to the form path - with an explicit reason - when no key is configured', () => {
    const selection = selectGreenhouseSubmissionPath({ url: URL_OK, submissionMode: 'REAL', env: {} });
    expect(selection.path).toBe('BROWSER_FORM');
    if (selection.path === 'BROWSER_FORM') {
      expect(selection.reason).toMatch(/Job Board API key/i);
    }
  });

  it('falls back with an explicit reason when the URL exposes no board/job pair', () => {
    const selection = selectGreenhouseSubmissionPath({
      url: 'https://jobs.example.com/apply',
      submissionMode: 'REAL',
      env: ENV_WITH_KEY,
    });
    expect(selection.path).toBe('BROWSER_FORM');
    if (selection.path === 'BROWSER_FORM') {
      expect(selection.reason).toMatch(/board token/i);
    }
  });

  it('MOCK mode only uses the API path against a LOOPBACK fixture base', () => {
    expect(
      selectGreenhouseSubmissionPath({
        url: 'http://127.0.0.1:9123/test-board/jobs/127817',
        submissionMode: 'MOCK',
        env: ENV_WITH_KEY_AND_FIXTURE,
      }).path
    ).toBe('JOB_BOARD_API');

    // No base override: a mock run must NEVER reach the real API host.
    const noBase = selectGreenhouseSubmissionPath({
      url: 'http://127.0.0.1:9123/test-board/jobs/127817',
      submissionMode: 'MOCK',
      env: ENV_WITH_KEY,
    });
    expect(noBase.path).toBe('BROWSER_FORM');

    // Non-loopback base override: refused as well.
    const remoteBase = selectGreenhouseSubmissionPath({
      url: 'http://127.0.0.1:9123/test-board/jobs/127817',
      submissionMode: 'MOCK',
      env: {
        JAA_GREENHOUSE_JOB_BOARD_API_KEY: 'test-key',
        JAA_GREENHOUSE_JOB_BOARD_API_BASE: 'https://boards-api.greenhouse.io',
      },
    });
    expect(remoteBase.path).toBe('BROWSER_FORM');
    if (remoteBase.path === 'BROWSER_FORM') {
      expect(remoteBase.reason).toMatch(/loopback/i);
    }
  });
});

describe('buildGreenhouseJobBoardInput', () => {
  const questions: GreenhouseJobBoardQuestion[] = [
    {
      required: true,
      label: 'First Name',
      fields: [{ name: 'first_name', type: 'input_text' }],
    },
    {
      required: true,
      label: 'Last Name',
      fields: [{ name: 'last_name', type: 'input_text' }],
    },
    { required: true, label: 'Email', fields: [{ name: 'email', type: 'input_text' }] },
    {
      required: true,
      label: 'Resume',
      fields: [
        { name: 'resume', type: 'input_file' },
        { name: 'resume_text', type: 'textarea' },
      ],
    },
    {
      required: true,
      label: 'Do you accept the privacy policy?',
      fields: [
        {
          name: 'question_2222',
          type: 'multi_value_single_select',
          values: [
            { value: 1, label: 'Yes' },
            { value: 0, label: 'No' },
          ],
        },
      ],
    },
    {
      required: false,
      label: 'Anything else?',
      fields: [{ name: 'question_3333', type: 'input_text' }],
    },
  ];

  const builtInFills: AtsFieldFill[] = [
    fill({
      value: 'Synthetic-first',
      label: 'First Name*',
      locator: { attributes: { semantic: 'first_name' } },
    }),
    fill({
      value: 'Synthetic-last',
      label: 'Last Name*',
      locator: { attributes: { semantic: 'last_name' } },
    }),
    fill({
      value: 'candidate@test.invalid',
      label: 'Email*',
      locator: { attributes: { semantic: 'email' } },
    }),
    fill({ value: 'Yes', label: 'Do you accept the privacy policy?*', fieldType: 'SELECT' }),
    fill({ value: 'Synthetic extra', label: 'Anything else?', required: false }),
    fill({
      value: 'test/synthetic-upload.txt',
      label: 'Resume/CV*',
      fieldType: 'FILE',
      locator: { attributes: { semantic: 'resume' } },
    }),
  ];

  it('maps built-in semantics and labels onto documented field names', () => {
    const build = buildGreenhouseJobBoardInput({
      questions,
      fills: builtInFills,
      resumeContentBase64: 'U3ludGhldGljIHJlc3VtZQ==',
      resumeFileName: 'synthetic-resume.txt',
    });
    expect(build.violations).toEqual([]);
    const byName = new Map(build.input.answers.map((a) => [a.name, a.value]));
    expect(byName.get('first_name')).toBe('Synthetic-first');
    expect(byName.get('last_name')).toBe('Synthetic-last');
    expect(byName.get('email')).toBe('candidate@test.invalid');
    // The approved answer text maps to the DOCUMENTED option value - never
    // guessed, never sent as free text.
    expect(byName.get('question_2222')).toBe(1);
    expect(byName.get('question_3333')).toBe('Synthetic extra');
    // The approved resume is the only file, sent as the documented
    // attachment.
    expect(build.input.resume).toEqual({
      contentBase64: 'U3ludGhldGljIHJlc3VtZQ==',
      filename: 'synthetic-resume.txt',
    });
    // The FILE answer is never sent as answer text.
    expect(build.input.answers.some((a) => String(a.value).includes('synthetic-upload'))).toBe(
      false
    );
  });

  it('never lets a semantic built-in overwrite a different documented question', () => {
    // A fill inspected as `first_name` but LABELLED "Preferred First Name"
    // must land on its own documented question - never on `first_name`.
    const build = buildGreenhouseJobBoardInput({
      questions: [
        ...questions,
        {
          required: false,
          label: 'Preferred First Name',
          fields: [{ name: 'question_5555', type: 'input_text' }],
        },
      ],
      fills: [
        ...builtInFills,
        fill({
          value: 'Synthetic-preferred',
          label: 'Preferred First Name',
          locator: { attributes: { semantic: 'first_name' } },
        }),
      ],
      resumeContentBase64: 'U3ludGhldGlj',
      resumeFileName: 'synthetic-resume.txt',
    });
    expect(build.violations).toEqual([]);
    const byName = new Map(build.input.answers.map((a) => [a.name, a.value]));
    // The label match wins: the answer goes to its own documented question.
    expect(byName.get('question_5555')).toBe('Synthetic-preferred');
    // The built-in `first_name` still carries only the genuine First Name
    // answer - the semantic hint never overwrote it.
    expect(byName.get('first_name')).toBe('Synthetic-first');
  });

  it('blocks (never guesses) when an approved choice matches no documented option', () => {
    const build = buildGreenhouseJobBoardInput({
      questions,
      fills: [
        ...builtInFills.filter((f) => f.label !== 'Do you accept the privacy policy?*'),
        fill({ value: 'Maybe', label: 'Do you accept the privacy policy?*', fieldType: 'SELECT' }),
      ],
      resumeContentBase64: 'U3ludGhldGlj',
      resumeFileName: 'synthetic-resume.txt',
    });
    expect(build.violations.map((v) => v.field)).toContain('question_2222');
    expect(build.input.answers.some((a) => a.name === 'question_2222')).toBe(false);
  });

  it('blocks when a required documented question has no grounded answer', () => {
    const build = buildGreenhouseJobBoardInput({
      questions,
      fills: builtInFills.filter((f) => f.fieldType !== 'FILE'),
      resumeContentBase64: null,
      resumeFileName: null,
    });
    // The required Resume question is unanswered (no attachment, no text).
    expect(build.violations.map((v) => v.field)).toContain('resume');
  });

  it('blocks ambiguous label matches and warns - never guesses a question', () => {
    const build = buildGreenhouseJobBoardInput({
      questions: [
        ...questions,
        { required: false, label: 'Anything else?', fields: [{ name: 'question_4444', type: 'input_text' }] },
      ],
      fills: builtInFills,
      resumeContentBase64: 'U3ludGhldGlj',
      resumeFileName: 'synthetic-resume.txt',
    });
    expect(build.violations.some((v) => v.problem.includes('never guessed'))).toBe(true);
  });

  it('warns (PII-free) for answers with no documented question and never sends them', () => {
    const build = buildGreenhouseJobBoardInput({
      questions,
      fills: [
        ...builtInFills,
        fill({ value: 'Qwerty-Secret-42', label: 'Unmapped custom question' }),
      ],
      resumeContentBase64: 'U3ludGhldGlj',
      resumeFileName: 'synthetic-resume.txt',
    });
    expect(build.violations).toEqual([]);
    expect(build.warnings.join(' ')).toMatch(/Unmapped custom question/);
    // Diagnostics never contain the answer value.
    expect(build.warnings.join(' ')).not.toContain('Qwerty-Secret-42');
    expect(build.input.answers.some((a) => a.value === 'Qwerty-Secret-42')).toBe(false);
  });
});

describe('pre-transmission failure classification', () => {
  it('treats a refused connection as a KNOWN pre-transmission failure (nothing sent)', async () => {
    // A loopback port that was bound and then released: connecting is
    // always refused, so the request is provably never transmitted.
    const deadPort = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    let thrown: unknown;
    try {
      await submitGreenhouseJobBoardApplication({
        apiKey: 'test-key',
        boardToken: 'test-board',
        jobPostId: '127817',
        input: {
          answers: [
            { name: 'first_name', value: 'Synthetic' },
            { name: 'last_name', value: 'Candidate' },
            { name: 'email', value: 'candidate@test.invalid' },
          ],
        },
        baseUrl: `http://127.0.0.1:${deadPort}`,
        timeoutMs: 5_000,
      });
    } catch (err) {
      thrown = err;
    }
    expect(isAtsError(thrown)).toBe(true);
    if (isAtsError(thrown)) {
      expect(thrown.code).toBe('SUBMISSION_FAILED');
      expect(thrown.message).toMatch(/never transmitted/i);
    }
    expect(isDefinitelyNotTransmitted({ cause: { code: 'ECONNREFUSED' } })).toBe(true);
    expect(isDefinitelyNotTransmitted({ cause: { code: 'ENOTFOUND' } })).toBe(true);
    expect(
      isDefinitelyNotTransmitted({ cause: { errors: [{ code: 'ECONNREFUSED' }] } })
    ).toBe(true);
    // Mid-request deaths stay UNKNOWN: when in doubt, the outcome is always
    // unknown and never retried.
    expect(isDefinitelyNotTransmitted({ cause: { code: 'ECONNRESET' } })).toBe(false);
    expect(isDefinitelyNotTransmitted({ name: 'AbortError' })).toBe(false);
  });
});
