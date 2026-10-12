/**
 * Phase 15B.1 - documented Greenhouse Job Board API submission path tests.
 *
 * Everything runs against the local mock Job Board API fixture (loopback
 * only, never the network, never a live target, no real submission).
 *
 * Safety invariants proven here:
 *  - client-side required-field validation refuses BEFORE any request is
 *    sent (documented: Greenhouse will not reject missing required fields);
 *  - exactly ONE request per attempt - never a retry (no idempotency key
 *    exists, so a request that may have landed is never repeated);
 *  - unknown outcomes (network failure / 5xx) THROW SUBMISSION_UNCONFIRMED
 *    and are never retried;
 *  - provider 4xx is a definitive refusal (nothing submitted);
 *  - the SSRF guard refuses any base URL except the documented API host or
 *    loopback mock fixtures;
 *  - only the approved resume (documented file types) is ever sent;
 *  - answer values and the API key never appear in results or errors.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isAtsError } from '@jaa/ats';

import {
  GREENHOUSE_JOB_BOARD_API_BASE,
  buildGreenhouseJobBoardRequestBody,
  extractGreenhouseJobBoardReference,
  fetchGreenhouseJobBoardQuestions,
  findUnansweredRequiredQuestions,
  resolveJobBoardApiBase,
  submitGreenhouseJobBoardApplication,
  validateGreenhouseJobBoardApplication,
  type GreenhouseJobBoardApplicationInput,
} from '../src/job-board-api';
import {
  startMockJobBoardApiServer,
  type MockJobBoardApiServer,
} from './fixtures/mock-job-board-api';

const SENTINEL = 'Qwerty-Secret-Answer-42';
const API_KEY = 'test-job-board-key';

function applicationInput(
  overrides: Partial<GreenhouseJobBoardApplicationInput> = {}
): GreenhouseJobBoardApplicationInput {
  return {
    answers: [
      { name: 'first_name', value: 'Test' },
      { name: 'last_name', value: 'Candidate' },
      { name: 'email', value: 'test-candidate@example.com' },
      { name: 'phone', value: '+1 555 010 0100' },
      { name: 'question_2222', value: '1' },
      { name: 'question_3333', value: SENTINEL },
    ],
    resume: {
      contentBase64: Buffer.from('%PDF-1.4 synthetic test resume').toString('base64'),
      filename: 'approved-resume.pdf',
    },
    ...overrides,
  };
}

let server: MockJobBoardApiServer | null = null;
const extraServers: MockJobBoardApiServer[] = [];

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  while (extraServers.length > 0) {
    await extraServers.pop()!.close();
  }
});

describe('Greenhouse Job Board API - documented non-browser submission path', () => {
  describe('base URL policy (SSRF guard)', () => {
    it('uses the documented API host by default', () => {
      expect(resolveJobBoardApiBase()).toBe(GREENHOUSE_JOB_BOARD_API_BASE);
    });

    it('accepts loopback base URLs for local mock fixtures only', () => {
      expect(resolveJobBoardApiBase('http://127.0.0.1:61500')).toBe('http://127.0.0.1:61500');
      expect(resolveJobBoardApiBase('http://[::1]:61500/')).toBe('http://[::1]:61500');
    });

    it.each([
      'http://169.254.169.254/latest/meta-data',
      'http://internal.service.local/v1',
      'http://10.0.0.5/v1',
      'file:///etc/passwd',
      'https://user:pass@boards-api.greenhouse.io',
      'not-a-url',
    ])('refuses the non-approved base URL %s before any request', async (baseUrl) => {
      server = await startMockJobBoardApiServer();
      let threw = false;
      try {
        await submitGreenhouseJobBoardApplication({
          apiKey: API_KEY,
          boardToken: 'test',
          jobPostId: '1',
          input: applicationInput(),
          baseUrl,
        });
      } catch (err) {
        threw = true;
        expect(isAtsError(err)).toBe(true);
        if (isAtsError(err)) expect(err.code).toBe('BLOCKED_BY_SECURITY_POLICY');
      }
      expect(threw).toBe(true);
      expect(server.requests).toHaveLength(0);
      expect(server.submissions).toHaveLength(0);
    });
  });

  describe('client-side required-field validation (documented rule)', () => {
    it('refuses missing first_name/last_name/email BEFORE sending anything', async () => {
      server = await startMockJobBoardApiServer();
      const result = await submitGreenhouseJobBoardApplication({
        apiKey: API_KEY,
        boardToken: 'test',
        jobPostId: '127817',
        baseUrl: server.url,
        input: applicationInput({ answers: [{ name: 'email', value: 'x@example.com' }] }),
      });
      expect(result.kind).toBe('BLOCKED');
      if (result.kind === 'BLOCKED') {
        expect(result.violations.map((v) => v.field).sort()).toEqual([
          'first_name',
          'last_name',
        ]);
        expect(result.violations.every((v) => v.problem.includes('required'))).toBe(true);
        for (const violation of result.violations) {
          expect(violation.problem).not.toContain(SENTINEL);
        }
      }
      // Nothing was sent: the mock provider saw zero requests.
      expect(server.requests).toHaveLength(0);
      expect(server.submissions).toHaveLength(0);
    });

    it('refuses documented field violations (URL in name, bad email, oversized field)', async () => {
      server = await startMockJobBoardApiServer();
      const result = await submitGreenhouseJobBoardApplication({
        apiKey: API_KEY,
        boardToken: 'test',
        jobPostId: '127817',
        baseUrl: server.url,
        input: applicationInput({
          answers: [
            { name: 'first_name', value: 'https://spam.example/x' },
            { name: 'last_name', value: 'A'.repeat(300) },
            { name: 'email', value: 'not-an-email' },
          ],
        }),
      });
      expect(result.kind).toBe('BLOCKED');
      if (result.kind === 'BLOCKED') {
        const problems = result.violations.map((v) => `${v.field}:${v.problem}`).join(' | ');
        expect(problems).toContain('first_name');
        expect(problems).toContain('must not contain a URL');
        expect(problems).toContain('last_name');
        expect(problems).toContain('at most 255 characters');
        expect(problems).toContain('email');
        expect(problems).toContain('valid email');
      }
      expect(server.requests).toHaveLength(0);
    });

    it('refuses a missing API key before sending anything', async () => {
      server = await startMockJobBoardApiServer();
      const result = await submitGreenhouseJobBoardApplication({
        apiKey: '',
        boardToken: 'test',
        jobPostId: '127817',
        baseUrl: server.url,
        input: applicationInput(),
      });
      expect(result.kind).toBe('BLOCKED');
      expect(server.requests).toHaveLength(0);
    });

    it('refuses unsupported attachment file types before sending anything', async () => {
      server = await startMockJobBoardApiServer();
      const result = await submitGreenhouseJobBoardApplication({
        apiKey: API_KEY,
        boardToken: 'test',
        jobPostId: '127817',
        baseUrl: server.url,
        input: applicationInput({
          resume: { contentBase64: 'TVqQAAMAAC7', filename: 'resume.exe' },
        }),
      });
      expect(result.kind).toBe('BLOCKED');
      if (result.kind === 'BLOCKED') {
        expect(result.violations.some((v) => v.field === 'resume')).toBe(true);
      }
      expect(server.requests).toHaveLength(0);
    });
  });

  describe('submission outcomes', () => {
    it('accepts a valid application with exactly one request and provider evidence', async () => {
      server = await startMockJobBoardApiServer();
      const result = await submitGreenhouseJobBoardApplication({
        apiKey: API_KEY,
        boardToken: 'test',
        jobPostId: '127817',
        baseUrl: server.url,
        input: applicationInput(),
      });
      expect(result.kind).toBe('ACCEPTED');
      if (result.kind === 'ACCEPTED') {
        expect(result.httpStatus).toBe(200);
        expect(result.reference).toBe('900001');
      }
      expect(server.requests).toHaveLength(1);
      expect(server.submissions).toHaveLength(1);

      // The approved resume travels as the documented base64 JSON fields.
      const body = server.submissions[0];
      expect(body.resume_content).toBeDefined();
      expect(body.resume_content_filename).toBe('approved-resume.pdf');
      // The Basic Auth username is the API key (documented), no password.
      expect(server.requests[0].authorization).toBe(
        `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`
      );
    });

    it('treats a 2xx with an undocumented empty body as accepted without a reference', async () => {
      server = await startMockJobBoardApiServer({ behavior: 'empty-body' });
      const result = await submitGreenhouseJobBoardApplication({
        apiKey: API_KEY,
        boardToken: 'test',
        jobPostId: '127817',
        baseUrl: server.url,
        input: applicationInput(),
      });
      expect(result.kind).toBe('ACCEPTED');
      if (result.kind === 'ACCEPTED') expect(result.reference).toBeNull();
      expect(server.requests).toHaveLength(1);
    });

    it('maps a 401 provider refusal to a definitive REFUSED with exactly one request (never retried)', async () => {
      server = await startMockJobBoardApiServer();
      const result = await submitGreenhouseJobBoardApplication({
        apiKey: 'wrong-key',
        boardToken: 'test',
        jobPostId: '127817',
        baseUrl: server.url,
        input: applicationInput(),
      });
      expect(result.kind).toBe('REFUSED');
      if (result.kind === 'REFUSED') {
        expect(result.httpStatus).toBe(401);
        expect(result.detail).not.toContain(SENTINEL);
      }
      expect(server.requests).toHaveLength(1);
      expect(server.submissions).toHaveLength(0);
    });

    it('maps a 422 provider validation refusal (field-type mismatch) to a definitive REFUSED', async () => {
      server = await startMockJobBoardApiServer();
      // Documented: "Field values must match the field type specified on
      // the job post question" - a free-text answer to the single-select
      // question_2222 passes our identity-field gate but the provider
      // refuses it with 422. Provider 4xx = definitive refusal, nothing
      // submitted, exactly one request.
      const result = await submitGreenhouseJobBoardApplication({
        apiKey: API_KEY,
        boardToken: 'test',
        jobPostId: '127817',
        baseUrl: server.url,
        input: applicationInput({
          answers: [
            { name: 'first_name', value: 'Test' },
            { name: 'last_name', value: 'Candidate' },
            { name: 'email', value: 'test-candidate@example.com' },
            { name: 'question_2222', value: SENTINEL },
          ],
        }),
      });
      expect(result.kind).toBe('REFUSED');
      if (result.kind === 'REFUSED') {
        expect(result.httpStatus).toBe(422);
        expect(result.detail).not.toContain(SENTINEL);
      }
      expect(server.requests).toHaveLength(1);
      expect(server.submissions).toHaveLength(0);
    });

    it('throws SUBMISSION_UNCONFIRMED on a provider 5xx - unknown outcome, exactly one request', async () => {
      server = await startMockJobBoardApiServer({ behavior: 'server-error' });
      let threw = false;
      try {
        await submitGreenhouseJobBoardApplication({
          apiKey: API_KEY,
          boardToken: 'test',
          jobPostId: '127817',
          baseUrl: server.url,
          input: applicationInput(),
        });
      } catch (err) {
        threw = true;
        expect(isAtsError(err)).toBe(true);
        if (isAtsError(err)) {
          expect(err.code).toBe('SUBMISSION_UNCONFIRMED');
          expect(err.message).not.toContain(SENTINEL);
        }
      }
      expect(threw).toBe(true);
      expect(server.requests).toHaveLength(1);
    });

    it('throws SUBMISSION_UNCONFIRMED when the connection dies mid-request - never retried', async () => {
      server = await startMockJobBoardApiServer({ behavior: 'destroy' });
      let threw = false;
      try {
        await submitGreenhouseJobBoardApplication({
          apiKey: API_KEY,
          boardToken: 'test',
          jobPostId: '127817',
          baseUrl: server.url,
          input: applicationInput(),
        });
      } catch (err) {
        threw = true;
        expect(isAtsError(err)).toBe(true);
        if (isAtsError(err)) expect(err.code).toBe('SUBMISSION_UNCONFIRMED');
      }
      expect(threw).toBe(true);
      // Exactly one request: the client NEVER retries an unknown outcome.
      expect(server.requests).toHaveLength(1);
    });

    it('never follows a redirect on the submission POST - unknown outcome, zero requests to the redirect target', async () => {
      const redirectTarget = await startMockJobBoardApiServer();
      extraServers.push(redirectTarget);
      server = await startMockJobBoardApiServer({
        behavior: 'redirect',
        redirectTarget: `${redirectTarget.url}/v1/boards/test/jobs/127817`,
      });
      let threw = false;
      try {
        await submitGreenhouseJobBoardApplication({
          apiKey: API_KEY,
          boardToken: 'test',
          jobPostId: '127817',
          baseUrl: server.url,
          input: applicationInput(),
        });
      } catch (err) {
        threw = true;
        expect(isAtsError(err)).toBe(true);
        if (isAtsError(err)) {
          // A 3xx is neither an acceptance nor a proven refusal: UNKNOWN.
          expect(err.code).toBe('SUBMISSION_UNCONFIRMED');
          expect(err.message).toContain('never followed');
        }
      }
      expect(threw).toBe(true);
      // The 307 was received but NEVER followed: the application body
      // (candidate data + resume) was not re-sent anywhere.
      expect(server.requests).toHaveLength(1);
      expect(redirectTarget.requests).toHaveLength(0);
      expect(redirectTarget.submissions).toHaveLength(0);
    });
  });

  describe('question discovery + answer coverage (client-side validation source)', () => {
    it('fetches the documented question list and finds unanswered required questions', async () => {
      server = await startMockJobBoardApiServer();
      const questions = await fetchGreenhouseJobBoardQuestions({
        boardToken: 'test',
        jobPostId: '127817',
        baseUrl: server.url,
      });
      expect(questions.length).toBeGreaterThan(0);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].method).toBe('GET');

      const answers = applicationInput().answers.filter((a) => a.name !== 'question_2222');
      // "Resume" (resume OR resume_text) and question_2222 are required by
      // the fixture and unanswered here -> coverage check must flag them.
      const missing = findUnansweredRequiredQuestions(questions, answers);
      expect(missing).toContain('question_2222');
      expect(missing).toContain('resume');

      // With every required question answered, the check passes.
      const complete = findUnansweredRequiredQuestions(questions, [
        ...answers,
        { name: 'question_2222', value: '1' },
        { name: 'resume_text', value: 'approved resume text' },
      ]);
      expect(complete).toEqual([]);
    });

    it('never leaks answer values through the coverage check', () => {
      const missing = findUnansweredRequiredQuestions(
        [
          {
            required: true,
            label: 'Secret question',
            fields: [{ name: 'question_9999', type: 'input_text' }],
          },
        ],
        [{ name: 'other', value: SENTINEL }]
      );
      expect(missing).toEqual(['question_9999']);
      expect(JSON.stringify(missing)).not.toContain(SENTINEL);
    });

    it('never follows a redirect on the question-list GET (SSRF via redirect)', async () => {
      const redirectTarget = await startMockJobBoardApiServer();
      extraServers.push(redirectTarget);
      server = await startMockJobBoardApiServer({
        behavior: 'redirect',
        redirectTarget: `${redirectTarget.url}/v1/boards/test/jobs/127817`,
      });
      let threw = false;
      try {
        await fetchGreenhouseJobBoardQuestions({
          boardToken: 'test',
          jobPostId: '127817',
          baseUrl: server.url,
        });
      } catch (err) {
        threw = true;
        expect(isAtsError(err)).toBe(true);
        if (isAtsError(err)) expect(err.code).toBe('INSPECTION_FAILED');
      }
      expect(threw).toBe(true);
      expect(redirectTarget.requests).toHaveLength(0);
    });
  });

  describe('payload + validation units', () => {
    it('stores provider identifiers only when actually returned and validated', () => {
      // A real returned id is stored as-is.
      expect(extractGreenhouseJobBoardReference('{"id": 9001}')).toBe('9001');
      expect(extractGreenhouseJobBoardReference('{"id": "  app-7  "}')).toBe('app-7');
      // An empty or invalid `id` must not mask a valid `application_id`.
      expect(extractGreenhouseJobBoardReference('{"id": "", "application_id": 7}')).toBe('7');
      expect(
        extractGreenhouseJobBoardReference('{"id": {"nested": true}, "application_id": 2}')
      ).toBe('2');
      // Non-scalar or empty values never become a reference (never
      // invented, never coerced from unrelated fields).
      expect(extractGreenhouseJobBoardReference('{"id": true}')).toBeNull();
      expect(extractGreenhouseJobBoardReference('{"id": [1, 2]}')).toBeNull();
      expect(extractGreenhouseJobBoardReference('{"id": ""}')).toBeNull();
      expect(extractGreenhouseJobBoardReference('')).toBeNull();
      expect(extractGreenhouseJobBoardReference('<html>not json</html>')).toBeNull();
      expect(extractGreenhouseJobBoardReference('{"confirmation": "yes"}')).toBeNull();
    });
    it('builds the documented JSON body with only the approved resume attached', () => {
      const body = buildGreenhouseJobBoardRequestBody(
        applicationInput({ coverLetter: null })
      );
      expect(body.first_name).toBe('Test');
      expect(body.resume_content).toBeDefined();
      expect(body.resume_content_filename).toBe('approved-resume.pdf');
      expect(body.cover_letter_content).toBeUndefined();
    });

    it('reports validation problems by field name only (PII-free)', () => {
      const violations = validateGreenhouseJobBoardApplication(
        applicationInput({ answers: [{ name: 'email', value: SENTINEL }] })
      );
      const serialized = JSON.stringify(violations);
      expect(serialized).not.toContain(SENTINEL);
      expect(violations.map((v) => v.field)).toContain('first_name');
    });

    it('accepts an empty attachment refusal (documented: files must be > 0 bytes)', () => {
      const violations = validateGreenhouseJobBoardApplication(
        applicationInput({
          resume: { contentBase64: '', filename: 'empty.pdf' },
        })
      );
      expect(violations.some((v) => v.field === 'resume' && v.problem.includes('empty'))).toBe(
        true
      );
    });
  });
});
