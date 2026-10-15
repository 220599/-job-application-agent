/**
 * Phase 15C - local mock of the documented Lever v1 API (loopback only,
 * never the network, never a live target, no real submission).
 *
 * Endpoints (the documented contract, hire.lever.co/developer/documentation):
 *   GET  /v1/postings/:posting/apply  - "Retrieve posting application
 *        questions" (the ordered question schema);
 *   POST /v1/uploads                  - temporary file upload (multipart/
 *        form-data) -> { data: { uri, filename, id, size, expiresAt } };
 *   POST /v1/postings/:posting/apply  - "Apply to a posting" ->
 *        201 Created { data: { applicationId } }.
 *
 * `behavior` can force the documented failure shapes for negative tests:
 *   'ok'            - 201 with the documented { data: { applicationId } };
 *   'no-reference'  - 2xx WITHOUT the documented application id (not
 *                     acceptance evidence);
 *   'empty-body'    - 2xx with an empty body;
 *   'malformed-body' - 2xx with a non-JSON body;
 *   'reject'        - 422 with a JSON error body (definitive refusal);
 *   'unauthorized'  - 401 (the configured credentials are refused);
 *   'forbidden'     - 403 (account settings do not authorize the operation);
 *   'rate-limit'    - 429 (documented: creates NO application);
 *   'server-error'  - 500 (outcome must be treated as UNKNOWN);
 *   'destroy'       - the connection is destroyed mid-request (network
 *                     failure; outcome must be treated as UNKNOWN);
 *   'redirect'      - 302 to `redirectTargetUrl` (never followed; the
 *                     redirect target must receive ZERO requests).
 *
 * Every request is recorded in `requests` so tests can prove EXACTLY how
 * many requests were issued (the client must never retry the application
 * request) and that a refused/blocked call sent nothing.
 */

import http from 'http';
import type { AddressInfo } from 'net';

export type MockLeverApiBehavior =
  | 'ok'
  | 'no-reference'
  | 'empty-body'
  | 'malformed-body'
  | 'reject'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limit'
  | 'server-error'
  | 'destroy'
  | 'redirect';

export interface MockLeverApiField {
  id?: string;
  name?: string;
  text: string;
  type: string;
  required: boolean;
  options?: { text: string; optionId?: string }[];
}

export interface MockLeverApiQuestionSet {
  id: string;
  text: string;
  fields: MockLeverApiField[];
}

/** The documented question schema shape (trimmed). */
export interface MockLeverApiSchema {
  customQuestions: MockLeverApiQuestionSet[];
  personalInformation: MockLeverApiField[];
  urls: MockLeverApiField[];
  eeoQuestions: Record<string, MockLeverApiField>;
}

export interface MockLeverApiOptions {
  /** The API key the mock provider requires (Basic Auth username). */
  apiKey?: string;
  behavior?: MockLeverApiBehavior;
  schema?: MockLeverApiSchema;
  /** Where a `redirect` 302 points (a second server can count hits). */
  redirectTargetUrl?: string;
  /**
   * Deterministic PRE-TRANSMISSION failure fixture: answer the upload
   * request, then stop listening (with `Connection: close`). The
   * application POST that follows cannot establish a connection and fails
   * with ECONNREFUSED - a request that provably NEVER left the client
   * machine.
   */
  closeAfterUpload?: boolean;
}

export interface MockLeverApiServer {
  url: string;
  /** Every request the server received, in order. */
  requests: { method: string; path: string; authorization: string | null }[];
  /** Files the mock provider accepted through POST /v1/uploads. */
  uploads: { filename: string; size: number; uri: string }[];
  /** Applications the mock provider accepted (documented request bodies). */
  submissions: Record<string, unknown>[];
  close(): Promise<void>;
  setBehavior(behavior: MockLeverApiBehavior): void;
  /**
   * Clear recorded requests/uploads/submissions so each test observes only
   * its own traffic (the arrays are shared across tests otherwise).
   */
  reset(): void;
}

const DEFAULT_SCHEMA: MockLeverApiSchema = {
  personalInformation: [
    { name: 'fullName', text: 'Full name', type: 'text', required: true },
    { name: 'email', text: 'Email', type: 'text', required: true },
    { name: 'currentCompany', text: 'Current company', type: 'text', required: false },
    { name: 'phone', text: 'Phone', type: 'text', required: false },
    { name: 'resume', text: 'Resume', type: 'file-upload', required: false },
    {
      name: 'additionalInformation',
      text: 'Additional information',
      type: 'textarea',
      required: false,
    },
  ],
  urls: [
    { name: 'LinkedIn', text: 'LinkedIn', type: 'text', required: false },
    { name: 'Other Website', text: 'Other Website', type: 'text', required: false },
    { name: 'Github', text: 'Github', type: 'text', required: false },
  ],
  customQuestions: [
    {
      id: '75f54523-ff77-4307-a868-08392ee02cab',
      text: 'Screening',
      fields: [
        {
          id: 'field-authorized',
          text: 'Are you authorized to work in the United States?',
          type: 'dropdown',
          required: true,
          options: [
            { text: 'Yes', optionId: 'Yes' },
            { text: 'No', optionId: 'No' },
          ],
        },
        {
          id: 'field-languages',
          text: 'Which languages or frameworks are you comfortable with?',
          type: 'multiple-select',
          required: false,
          options: [
            { text: 'JavaScript', optionId: 'JavaScript' },
            { text: 'Python', optionId: 'Python' },
            { text: 'Ruby', optionId: 'Ruby' },
          ],
        },
        {
          id: 'field-experience',
          text: 'What experience do you have?',
          type: 'textarea',
          required: false,
        },
      ],
    },
  ],
  eeoQuestions: {
    gender: {
      name: 'gender',
      text: 'Gender',
      type: 'dropdown',
      required: false,
      options: [
        { text: 'Female', optionId: 'Female' },
        { text: 'Male', optionId: 'Male' },
        { text: 'Decline to self-identify', optionId: 'Decline to self-identify' },
      ],
    },
    disabilitySignature: {
      name: 'disabilitySignature',
      text: 'Disability signature',
      type: 'text',
      required: false,
    },
  },
};

export async function startMockLeverApiServer(
  options: MockLeverApiOptions = {}
): Promise<MockLeverApiServer> {
  const apiKey = options.apiKey ?? 'test-lever-api-key';
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const closeAfterUpload = options.closeAfterUpload ?? false;
  const redirectTargetUrl = options.redirectTargetUrl ?? 'http://attacker.invalid/collect';
  let behavior: MockLeverApiBehavior = options.behavior ?? 'ok';
  const requests: MockLeverApiServer['requests'] = [];
  const uploads: MockLeverApiServer['uploads'] = [];
  const submissions: Record<string, unknown>[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: req.method ?? '',
      path: url.pathname,
      authorization: req.headers.authorization ?? null,
    });

    const expectedAuth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;

    // ---- GET /v1/postings/:posting/apply (documented question schema) --
    if (req.method === 'GET' && /^\/v1\/postings\/[^/]+\/apply$/.test(url.pathname)) {
      if (behavior === 'redirect') {
        res.writeHead(302, { location: redirectTargetUrl });
        res.end();
        return;
      }
      if (behavior === 'destroy') {
        req.socket.destroy();
        return;
      }
      if (behavior === 'unauthorized' || behavior === 'forbidden') {
        res.writeHead(behavior === 'unauthorized' ? 401 : 403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'Unauthorized', message: 'mock provider refused the key' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: {
            id: url.pathname.split('/')[3],
            text: 'Test Engineer',
            customQuestions: schema.customQuestions,
            eeoQuestions: schema.eeoQuestions,
            personalInformation: schema.personalInformation,
            urls: schema.urls,
          },
        })
      );
      return;
    }

    // ---- POST /v1/uploads (documented temporary file upload) ----------
    if (req.method === 'POST' && url.pathname === '/v1/uploads') {
      if (behavior === 'destroy') {
        req.socket.destroy();
        return;
      }
      if (behavior === 'unauthorized' || behavior === 'forbidden') {
        res.writeHead(behavior === 'unauthorized' ? 401 : 403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'Unauthorized', message: 'mock provider refused the key' }));
        return;
      }
      if (behavior === 'server-error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'InternalError', message: 'internal server error' }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const filename =
          /filename="([^"]*)"/.exec(raw.toString('latin1'))?.[1] ?? 'unknown';
        const uri = `https://api.lever.co/v1/uploads/083d56ef-mock-${uploads.length}-${filename}`;
        uploads.push({ filename, size: raw.length, uri });
        res.writeHead(200, {
          'content-type': 'application/json',
          // `Connection: close` keeps undici from pooling the socket, so
          // the application POST that follows must open a fresh connection
          // - and is refused before it is transmitted.
          ...(closeAfterUpload ? { connection: 'close' } : {}),
        });
        res.end(
          JSON.stringify({
            data: {
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
              filename,
              id: `083d56ef-mock-${uploads.length}`,
              uri,
              size: raw.length,
            },
          }),
          () => {
            if (closeAfterUpload) server.close();
          }
        );
      });
      return;
    }

    // ---- POST /v1/postings/:posting/apply (the submission) ------------
    if (req.method === 'POST' && /^\/v1\/postings\/[^/]+\/apply$/.test(url.pathname)) {
      if (behavior === 'destroy') {
        req.socket.destroy();
        return;
      }
      if (behavior === 'redirect') {
        res.writeHead(302, { location: redirectTargetUrl });
        res.end();
        return;
      }
      if (behavior === 'server-error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'InternalError', message: 'internal server error' }));
        return;
      }
      if (behavior === 'rate-limit') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'RateLimitExceeded', message: 'too many requests' }));
        return;
      }
      if (behavior === 'reject') {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'ValidationError', message: 'mock provider refused the application' }));
        return;
      }

      // Documented: Basic Auth where the username is the API key.
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'Unauthorized', message: 'invalid api key' }));
        return;
      }
      if (behavior === 'forbidden') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'Forbidden', message: 'account settings do not authorize this operation' }));
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        submissions.push(body);
        if (behavior === 'empty-body') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('');
          return;
        }
        if (behavior === 'malformed-body') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('not json at all');
          return;
        }
        if (behavior === 'no-reference') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        // Documented success: 201 Created + { data: { applicationId } }.
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: { applicationId: '915a6cef-4f91-4f3d-b8ff-a49e1eae2c30' },
          })
        );
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'ResourceNotFound', message: 'no such route' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    uploads,
    submissions,
    setBehavior(next: MockLeverApiBehavior) {
      behavior = next;
    },
    reset() {
      requests.length = 0;
      uploads.length = 0;
      submissions.length = 0;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
