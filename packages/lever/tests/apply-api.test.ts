/**
 * Phase 15C - documented Lever Apply API submission path tests.
 *
 * Everything runs against the local mock Lever API fixture (loopback
 * only, never the network, never a live target, no real submission).
 *
 * Safety invariants proven here:
 *  - acceptance evidence is ONLY the documented contract (2xx with the
 *    documented `data.applicationId`) - a bare 2xx is UNKNOWN, never
 *    accepted, never invented;
 *  - exactly ONE submission request per attempt - never a retry (no
 *    idempotency key exists, so a request that may have landed is never
 *    repeated);
 *  - unknown outcomes (network failure mid-request / 5xx / redirect / bare
 *    2xx) THROW SUBMISSION_UNCONFIRMED and are never retried;
 *  - provider 4xx is a definitive refusal (nothing created), and a 429 is
 *    the documented rate-limit refusal that creates NO application;
 *  - a connection that never established is a KNOWN pre-transmission
 *    failure ("never transmitted");
 *  - the SSRF guard refuses any base URL except the documented API host or
 *    loopback mock fixtures; redirects are never followed and the redirect
 *    target receives ZERO requests;
 *  - only the approved resume (documented upload formats/size) is ever
 *    sent, and only after ALL validation passed;
 *  - answer values and the API key never appear in results or errors.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isAtsError } from '@jaa/ats';

import {
  MAX_LEVER_UPLOAD_BYTES,
  extractLeverApplyReference,
  fetchLeverApplyQuestions,
  isDefinitelyNotTransmitted,
  parseLeverApplyQuestions,
  resolveLeverApiBase,
  submitLeverApplyApplication,
  uploadLeverApplyFile,
  validateLeverApplyApplication,
  validateLeverUploadFile,
  type LeverApplyInput,
  type LeverApplyQuestions,
} from '../src/apply-api';
import {
  buildLeverApplyInput,
  parseLeverPostingTarget,
  selectLeverSubmissionPath,
  withLeverResumeUri,
} from '../src/apply-submission';
import {
  startMockLeverApiServer,
  type MockLeverApiServer,
} from './fixtures/mock-lever-api';

const SENTINEL = 'Qwerty-Secret-Answer-42';
const API_KEY = 'test-lever-api-key';
const POSTING_ID = '250d8f03-738a-4bba-a671-8a3d73477145';

function baseInput(overrides: Partial<LeverApplyInput> = {}): LeverApplyInput {
  return {
    personalInformation: [
      { name: 'fullName', value: 'Test Candidate' },
      { name: 'email', value: 'test-candidate@test.invalid' },
      { name: 'additionalInformation', value: SENTINEL },
    ],
    urls: [],
    customQuestions: [
      {
        id: '75f54523-ff77-4307-a868-08392ee02cab',
        fields: [{ value: 'Yes' }, { value: [] }, { value: '' }],
      },
    ],
    eeoResponses: null,
    ...overrides,
  };
}

let server: MockLeverApiServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe('documented response semantics (the only acceptance evidence)', () => {
  it('1. accepts ONLY the documented success contract (2xx + data.applicationId) as PROVIDER_ID evidence', async () => {
    server = await startMockLeverApiServer();
    const result = await submitLeverApplyApplication({
      apiKey: API_KEY,
      postingId: POSTING_ID,
      baseUrl: server.url,
      input: baseInput(),
    });
    expect(result.kind).toBe('ACCEPTED');
    if (result.kind === 'ACCEPTED') {
      expect(result.reference).toBe('915a6cef-4f91-4f3d-b8ff-a49e1eae2c30');
      expect(result.httpStatus).toBe(201);
    }
    // Exactly one application request - never retried.
    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(server.submissions).toHaveLength(1);
  });

  it('2. treats a 2xx WITHOUT the documented application id as UNKNOWN (never accepted, never retried)', async () => {
    server = await startMockLeverApiServer({ behavior: 'no-reference' });
    let threw = false;
    try {
      await submitLeverApplyApplication({
        apiKey: API_KEY,
        postingId: POSTING_ID,
        baseUrl: server.url,
        input: baseInput(),
      });
    } catch (err) {
      threw = true;
      expect(isAtsError(err)).toBe(true);
      if (isAtsError(err)) expect(err.code).toBe('SUBMISSION_UNCONFIRMED');
    }
    expect(threw).toBe(true);
    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(server.submissions).toHaveLength(1); // the request DID land - but is not claimed
  });

  it('3. treats an empty response body as UNKNOWN and never invents a reference', async () => {
    server = await startMockLeverApiServer({ behavior: 'empty-body' });
    await expect(
      submitLeverApplyApplication({
        apiKey: API_KEY,
        postingId: POSTING_ID,
        baseUrl: server.url,
        input: baseInput(),
      })
    ).rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });
  });

  it('4. treats a malformed response body as UNKNOWN and never invents a reference', async () => {
    server = await startMockLeverApiServer({ behavior: 'malformed-body' });
    await expect(
      submitLeverApplyApplication({
        apiKey: API_KEY,
        postingId: POSTING_ID,
        baseUrl: server.url,
        input: baseInput(),
      })
    ).rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });
  });
});

describe('provider refusals are definitive (nothing created)', () => {
  it('5. maps a 422 provider refusal to a definitive REFUSED with exactly one request', async () => {
    server = await startMockLeverApiServer({ behavior: 'reject' });
    const result = await submitLeverApplyApplication({
      apiKey: API_KEY,
      postingId: POSTING_ID,
      baseUrl: server.url,
      input: baseInput(),
    });
    expect(result.kind).toBe('REFUSED');
    if (result.kind === 'REFUSED') {
      expect(result.httpStatus).toBe(422);
      expect(result.detail).not.toContain(SENTINEL);
    }
    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(server.submissions).toHaveLength(0);
  });

  it('6. maps the documented 429 rate-limit refusal to a definitive REFUSED (no application is created)', async () => {
    server = await startMockLeverApiServer({ behavior: 'rate-limit' });
    const result = await submitLeverApplyApplication({
      apiKey: API_KEY,
      postingId: POSTING_ID,
      baseUrl: server.url,
      input: baseInput(),
    });
    expect(result.kind).toBe('REFUSED');
    if (result.kind === 'REFUSED') {
      expect(result.httpStatus).toBe(429);
      expect(result.detail).toContain('no application');
    }
    expect(server.submissions).toHaveLength(0);
    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('7. maps 401/403 credential refusals to REFUSED without ever leaking the key', async () => {
    server = await startMockLeverApiServer();
    for (const apiKey of ['wrong-key-DO-NOT-LEAK-8d21', '']) {
      const result = await submitLeverApplyApplication({
        apiKey,
        postingId: POSTING_ID,
        baseUrl: server.url,
        input: baseInput(),
      });
      if (apiKey === '') {
        expect(result.kind).toBe('BLOCKED'); // refused before any request
        continue;
      }
      expect(result.kind).toBe('REFUSED');
      if (result.kind === 'REFUSED') {
        expect(result.httpStatus).toBe(401);
        expect(result.detail).not.toContain('DO-NOT-LEAK');
      }
    }
    expect(server.submissions).toHaveLength(0);
  });

  it('8. a connection-refused request is a KNOWN pre-transmission failure ("never transmitted")', async () => {
    server = await startMockLeverApiServer({ closeAfterUpload: true });
    const input = withLeverResumeUri(baseInput(), 'https://api.lever.co/v1/uploads/x-resume.pdf');
    let code = '';
    try {
      await uploadLeverApplyFile({
        apiKey: API_KEY,
        filename: 'resume.pdf',
        content: new Uint8Array(Buffer.from('%PDF-1.4 synthetic test resume')),
        baseUrl: server.url,
      });
      await submitLeverApplyApplication({
        apiKey: API_KEY,
        postingId: POSTING_ID,
        baseUrl: server.url,
        input,
      });
    } catch (err) {
      code = isAtsError(err) ? err.code : 'OTHER';
    }
    // The upload landed; the application POST could not even connect.
    expect(code).toBe('SUBMISSION_FAILED');
    expect(server.uploads).toHaveLength(1);
    expect(server.submissions).toHaveLength(0);
  });
});

describe('unknown outcomes are never retried blindly', () => {
  it('9. a provider 5xx is UNKNOWN - exactly one request', async () => {
    server = await startMockLeverApiServer({ behavior: 'server-error' });
    await expect(
      submitLeverApplyApplication({
        apiKey: API_KEY,
        postingId: POSTING_ID,
        baseUrl: server.url,
        input: baseInput(),
      })
    ).rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });
    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('10. a connection that dies mid-request is UNKNOWN and is never retried', async () => {
    server = await startMockLeverApiServer({ behavior: 'destroy' });
    await expect(
      submitLeverApplyApplication({
        apiKey: API_KEY,
        postingId: POSTING_ID,
        baseUrl: server.url,
        input: baseInput(),
      })
    ).rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });
    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(server.submissions).toHaveLength(0);
  });

  it('11. a redirect is NEVER followed and stays UNKNOWN - the redirect target receives zero requests', async () => {
    let targetHits = 0;
    const target = await startMockLeverApiServer();
    // Count hits on the "attacker" server by watching its request log.
    const targetServer = target;
    server = await startMockLeverApiServer({
      behavior: 'redirect',
      redirectTargetUrl: `${targetServer.url}/collect`,
    });
    await expect(
      submitLeverApplyApplication({
        apiKey: API_KEY,
        postingId: POSTING_ID,
        baseUrl: server.url,
        input: baseInput(),
      })
    ).rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });
    targetHits = targetServer.requests.length;
    expect(targetHits).toBe(0);
    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    await targetServer.close();
  });
});

describe('SSRF guard + base URL policy', () => {
  it('12. refuses any non-documented, non-loopback base URL before a connection is opened', () => {
    for (const bad of [
      'https://internal.corp.local',
      'https://169.254.169.254',
      'http://10.0.0.5',
      'ftp://api.lever.co',
      'https://user:pass@api.lever.co',
      'not a url',
    ]) {
      expect(() => resolveLeverApiBase(bad)).toThrowError(/BLOCKED|not allowed|could not be parsed|must not contain/);
    }
  });

  it('13. accepts the documented host and loopback mock fixtures only', () => {
    expect(resolveLeverApiBase()).toBe('https://api.lever.co');
    expect(resolveLeverApiBase('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999');
    expect(resolveLeverApiBase('http://127.0.0.1:9999/')).toBe('http://127.0.0.1:9999');
  });

  it('14. never follows a redirect on the read-only question fetch either', async () => {
    const target = await startMockLeverApiServer();
    server = await startMockLeverApiServer({
      behavior: 'redirect',
      redirectTargetUrl: `${target.url}/collect`,
    });
    await expect(
      fetchLeverApplyQuestions({ apiKey: API_KEY, postingId: POSTING_ID, baseUrl: server.url })
    ).rejects.toThrowError(/redirect/i);
    expect(target.requests).toHaveLength(0);
    await target.close();
  });
});

describe('pre-send validation blocks before anything is transmitted', () => {
  it('15. a missing required answer blocks BEFORE any request is sent (never fabricated)', async () => {
    server = await startMockLeverApiServer();
    const questions = parseLeverApplyQuestions(
      JSON.stringify({
        data: {
          id: POSTING_ID,
          customQuestions: [],
          eeoQuestions: {},
          personalInformation: [
            { name: 'fullName', text: 'Full name', type: 'text', required: true },
            { name: 'email', text: 'Email', type: 'text', required: true },
          ],
          urls: [],
        },
      })
    );
    const build = buildLeverApplyInput({
      questions,
      fills: [
        {
          questionId: 'q1',
          fieldType: 'TEXT',
          locator: null,
          value: 'Test Candidate',
          required: true,
          label: 'Full name',
        },
        // No Email answer - and it must NOT be invented.
      ],
    });
    expect(build.violations.some((v) => v.field === 'email')).toBe(true);
    const violations = validateLeverApplyApplication(build.input, questions);
    expect(violations.some((v) => v.field === 'email')).toBe(true);
    // Nothing was ever sent: the mock provider saw no request at all.
    expect(server.requests).toHaveLength(0);
  });

  it('16. an invalid or empty resume is refused BEFORE the upload (documented formats, 30MB)', () => {
    expect(
      validateLeverUploadFile({ filename: 'resume.exe', content: new Uint8Array([1, 2]) })
    ).toEqual([expect.objectContaining({ field: 'resume' })]);
    expect(
      validateLeverUploadFile({ filename: 'resume.pdf', content: new Uint8Array([]) })
    ).toEqual([expect.objectContaining({ field: 'resume' })]);
    expect(
      validateLeverUploadFile({
        filename: 'resume.pdf',
        content: new Uint8Array(MAX_LEVER_UPLOAD_BYTES + 1),
      })
    ).toEqual([expect.objectContaining({ field: 'resume' })]);
    expect(
      validateLeverUploadFile({ filename: 'resume.pdf', content: new Uint8Array([1, 2, 3]) })
    ).toEqual([]);
  });

  it('17. the approved resume upload references the documented uri and nothing else', async () => {
    server = await startMockLeverApiServer();
    const upload = await uploadLeverApplyFile({
      apiKey: API_KEY,
      filename: 'approved-resume.pdf',
      content: new Uint8Array(Buffer.from('%PDF-1.4 synthetic test resume')),
      baseUrl: server.url,
    });
    expect(upload.uri).toContain('/v1/uploads/');
    const input = withLeverResumeUri(baseInput(), upload.uri);
    expect(input.personalInformation.find((p) => p.name === 'resume')?.value).toBe(upload.uri);
    expect(server.uploads).toHaveLength(1);
  });
});

describe('documented schema parsing + strict reference extraction', () => {
  it('18. extracts only a documented data.applicationId string (never invented)', () => {
    expect(
      extractLeverApplyReference('{"data":{"applicationId":"915a6cef-4f91-4f3d-b8ff-a49e1eae2c30"}}')
    ).toBe('915a6cef-4f91-4f3d-b8ff-a49e1eae2c30');
    expect(extractLeverApplyReference('{"data":{"applicationId":""}}')).toBeNull();
    expect(extractLeverApplyReference('{"data":{"applicationId":"   "}}')).toBeNull();
    expect(extractLeverApplyReference('{"data":{"applicationId":123}}')).toBeNull();
    expect(extractLeverApplyReference('{"data":{}}')).toBeNull();
    expect(extractLeverApplyReference('{"ok":true}')).toBeNull();
    expect(extractLeverApplyReference('')).toBeNull();
    expect(extractLeverApplyReference('not json')).toBeNull();
  });

  it('19. parses the documented question schema strictly (nothing invented)', () => {
    const questions = parseLeverApplyQuestions(
      JSON.stringify({
        data: {
          id: POSTING_ID,
          text: 'Software Engineer',
          customQuestions: [
            {
              id: 'set-1',
              text: 'Screening',
              fields: [
                {
                  id: 'f1',
                  text: 'Authorized?',
                  type: 'dropdown',
                  required: true,
                  options: [{ text: 'Yes' }, { text: 'No' }],
                },
              ],
            },
          ],
          eeoQuestions: {
            gender: { text: 'Gender', type: 'dropdown', required: false, options: [{ text: 'Female' }] },
          },
          personalInformation: [
            { name: 'fullName', text: 'Full name', type: 'text', required: true },
            { name: 'email', text: 'Email', type: 'text', required: true },
          ],
          urls: [{ name: 'LinkedIn', text: 'LinkedIn', type: 'text', required: false }],
        },
      })
    );
    expect(questions.postingId).toBe(POSTING_ID);
    expect(questions.customQuestions).toHaveLength(1);
    expect(questions.customQuestions[0].fields[0].required).toBe(true);
    expect(questions.personalInformation.map((f) => f.name)).toEqual(['fullName', 'email']);
    expect(Object.keys(questions.eeoQuestions)).toEqual(['gender']);
  });

  it('20. the posting target parses the documented applyUrl shape and nothing else', () => {
    expect(parseLeverPostingTarget('https://jobs.lever.co/acme/250d8f03-738a-4bba-a671-8a3d73477145')).toEqual({
      site: 'acme',
      postingId: '250d8f03-738a-4bba-a671-8a3d73477145',
    });
    expect(
      parseLeverPostingTarget('https://jobs.lever.co/acme/250d8f03-738a-4bba-a671-8a3d73477145/apply')
    ).toEqual({ site: 'acme', postingId: '250d8f03-738a-4bba-a671-8a3d73477145' });
    expect(parseLeverPostingTarget('https://jobs.lever.co/acme')).toBeNull();
    expect(parseLeverPostingTarget('https://jobs.lever.co/acme/a/b/c')).toBeNull();
    expect(parseLeverPostingTarget('https://jobs.lever.co')).toBeNull();
    expect(parseLeverPostingTarget('https://user:pass@jobs.lever.co/acme/abc-123')).toBeNull();
    expect(parseLeverPostingTarget('not a url')).toBeNull();
  });

  it('21. a pre-transmission network error is recognized strictly', () => {
    expect(isDefinitelyNotTransmitted({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isDefinitelyNotTransmitted({ cause: { code: 'ENOTFOUND' } })).toBe(true);
    expect(isDefinitelyNotTransmitted({ errors: [{ code: 'ECONNREFUSED' }] })).toBe(true);
    expect(isDefinitelyNotTransmitted({ code: 'ECONNRESET' })).toBe(false);
    expect(isDefinitelyNotTransmitted(new Error('boom'))).toBe(false);
    expect(isDefinitelyNotTransmitted(null)).toBe(false);
  });
});

describe('server-side path selection (never a client choice)', () => {
  it('22. requires BOTH a posting id AND a configured employer key', () => {
    const url = `https://jobs.lever.co/acme/${POSTING_ID}`;
    const noKey = selectLeverSubmissionPath({ url, submissionMode: 'REAL', env: {} });
    expect(noKey.path).toBe('BROWSER_FORM');
    if (noKey.path === 'BROWSER_FORM') expect(noKey.reason).toContain('JAA_LEVER_API_KEY');

    const noId = selectLeverSubmissionPath({
      url: 'https://jobs.lever.co/acme',
      submissionMode: 'REAL',
      env: { JAA_LEVER_API_KEY: API_KEY },
    });
    expect(noId.path).toBe('BROWSER_FORM');

    const ok = selectLeverSubmissionPath({
      url,
      submissionMode: 'REAL',
      env: { JAA_LEVER_API_KEY: API_KEY },
    });
    expect(ok.path).toBe('LEVER_API');
  });

  it('23. a mock run can only ever reach a loopback fixture (never the real API)', () => {
    const url = `https://jobs.lever.co/acme/${POSTING_ID}`;
    const mockToReal = selectLeverSubmissionPath({
      url,
      submissionMode: 'MOCK',
      env: { JAA_LEVER_API_KEY: API_KEY },
    });
    expect(mockToReal.path).toBe('BROWSER_FORM');

    const mockToFixture = selectLeverSubmissionPath({
      url,
      submissionMode: 'MOCK',
      env: { JAA_LEVER_API_KEY: API_KEY, JAA_LEVER_API_BASE: 'http://127.0.0.1:9999' },
    });
    expect(mockToFixture.path).toBe('LEVER_API');
  });
});
