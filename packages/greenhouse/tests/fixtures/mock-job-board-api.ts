import http from 'http';
import type { AddressInfo } from 'net';

/**
 * Local mock Greenhouse Job Board API server for @jaa/greenhouse tests.
 *
 * Models the DOCUMENTED Job Board API behavior (docs.greenhouse.io/job-board)
 * on an ephemeral 127.0.0.1 port - never touches the network:
 *
 *   GET  /v1/boards/:board/jobs/:id?questions=true
 *     -> 200 job JSON with the documented `questions` array (no auth, as
 *        documented for GET endpoints);
 *   POST /v1/boards/:board/jobs/:id
 *     -> requires HTTP Basic Auth (username = configured API key, no
 *        password) or answers 401;
 *     -> validates the documented request rules (first_name/last_name/email
 *        required, valid email) or answers 422 with an errors array;
 *     -> accepts with 200 and records the submission.
 *
 * `behavior` can force the documented failure shapes for negative tests:
 *   'ok'            - 200 with a JSON body containing an id (default);
 *   'empty-body'    - 200 with an empty body (response body is undocumented);
 *   'malformed-body' - 200 with a non-JSON body (no id can be extracted);
 *   'reject'        - 422 with an errors array (definitive refusal);
 *   'server-error'  - 500 (outcome must be treated as UNKNOWN);
 *   'destroy'       - the connection is destroyed mid-request (network
 *                     failure; outcome must be treated as UNKNOWN);
 *   'redirect'      - 307 to `redirectTarget` (a redirect must NEVER be
 *                     followed: no request may reach the redirect target,
 *                     and the outcome must be treated as UNKNOWN).
 *
 * Every request is recorded in `requests` so tests can prove EXACTLY how
 * many requests were issued (the client must never retry) and that a
 * refused/blocked call sent nothing.
 */

export interface MockJobBoardApiServer {
  url: string;
  /** Every request the server received, in order. */
  requests: { method: string; path: string; authorization: string | null }[];
  /** Applications the mock provider accepted. */
  submissions: Record<string, unknown>[];
  close(): Promise<void>;
  setBehavior(behavior: MockJobBoardApiBehavior): void;
}

export type MockJobBoardApiBehavior =
  | 'ok'
  | 'empty-body'
  | 'malformed-body'
  | 'reject'
  | 'server-error'
  | 'destroy'
  | 'redirect';

export interface MockJobBoardApiQuestionField {
  name: string;
  type: string;
  /** Documented option values for `multi_value_*` field types. */
  values?: { value: string | number; label: string }[];
}

export interface MockJobBoardApiOptions {
  /** The API key the mock provider requires (Basic Auth username). */
  apiKey?: string;
  behavior?: MockJobBoardApiBehavior;
  /** Question list returned by the `?questions=true` job method. */
  questions?: {
    required: boolean;
    label: string;
    fields: MockJobBoardApiQuestionField[];
  }[];
  /**
   * Deterministic PRE-TRANSMISSION failure fixture: answer the read-only
   * question request, then stop listening (with `Connection: close` so no
   * pooled socket survives). The submission POST that follows cannot
   * establish a connection and fails with ECONNREFUSED - a request that
   * provably NEVER left the client machine.
   */
  closeAfterQuestions?: boolean;
  /** Where the 'redirect' behavior points (e.g. a second mock server). */
  redirectTarget?: string;
}

const DEFAULT_QUESTIONS = [
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
  {
    required: true,
    label: 'Email',
    fields: [{ name: 'email', type: 'input_text' }],
  },
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
    fields: [{ name: 'question_2222', type: 'multi_value_single_select' }],
  },
  {
    required: false,
    label: 'Anything else?',
    fields: [{ name: 'question_3333', type: 'input_text' }],
  },
];

export async function startMockJobBoardApiServer(
  options: MockJobBoardApiOptions = {}
): Promise<MockJobBoardApiServer> {
  const apiKey = options.apiKey ?? 'test-job-board-key';
  const questions = options.questions ?? DEFAULT_QUESTIONS;
  const closeAfterQuestions = options.closeAfterQuestions ?? false;
  const redirectTarget = options.redirectTarget ?? 'http://127.0.0.1:1/never-followed';
  let behavior: MockJobBoardApiBehavior = options.behavior ?? 'ok';
  const requests: MockJobBoardApiServer['requests'] = [];
  const submissions: Record<string, unknown>[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: req.method ?? '',
      path: url.pathname,
      authorization: req.headers.authorization ?? null,
    });

    if (behavior === 'redirect') {
      // 307 preserves method and body: a client that follows this would
      // re-send the candidate's application (and resume) to redirectTarget.
      // The client must refuse instead.
      res.writeHead(307, { location: redirectTarget });
      res.end();
      return;
    }

    if (req.method === 'GET' && /^\/v1\/boards\/[^/]+\/jobs\/[^/]+$/.test(url.pathname)) {
      if (closeAfterQuestions) {
        // Serve the question list, then stop listening. `Connection: close`
        // keeps undici from pooling the socket, so the submission POST must
        // open a fresh connection - and is refused before it is transmitted.
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(
          JSON.stringify({
            id: 127817,
            title: 'Test Engineer',
            questions,
          }),
          () => server.close()
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 127817,
          title: 'Test Engineer',
          questions,
        })
      );
      return;
    }

    if (req.method === 'POST' && /^\/v1\/boards\/[^/]+\/jobs\/[^/]+$/.test(url.pathname)) {
      if (behavior === 'destroy') {
        req.socket.destroy();
        return;
      }
      if (behavior === 'server-error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'internal server error' }));
        return;
      }
      if (behavior === 'reject') {
        // Documented 422 validation refusal - a definitive rejection:
        // nothing was submitted.
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ errors: ['mock provider refused the application'] }));
        return;
      }

      // Documented: Basic Auth where the username is the Job Board API key.
      const expected = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Invalid authentication credentials' }));
        return;
      }

      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ errors: ['request body must be JSON'] }));
          return;
        }

        // Documented field validations.
        const errors: string[] = [];
        for (const required of ['first_name', 'last_name', 'email']) {
          const value = body[required];
          if (typeof value !== 'string' || value.trim().length === 0) {
            errors.push(`${required} is required`);
          } else if (value.length > 255) {
            errors.push(`${required} must be at most 255 characters`);
          }
        }
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errors.push('email must be a valid email address');
        }
        // Documented: "Field values must match the field type specified on
        // the job post question" - single-select option values are numeric.
        for (const question of questions) {
          const field = question.fields[0];
          if (!field || field.type !== 'multi_value_single_select') continue;
          const value = body[field.name];
          if (value === undefined || value === null || value === '') continue;
          const values = Array.isArray(value) ? value : [value];
          const allNumeric = values.every(
            (v) => typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v.trim()))
          );
          if (!allNumeric) {
            errors.push(
              'field values must match the field type specified on the job post question'
            );
          }
        }
        if (errors.length > 0) {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ errors }));
          return;
        }

        submissions.push(body);
        if (behavior === 'empty-body') {
          res.writeHead(200);
          res.end();
          return;
        }
        if (behavior === 'malformed-body') {
          // 2xx with a body that is NOT the undocumented success shape -
          // no id can ever be extracted or invented from it.
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html><body>unexpected</body></html>');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 900000 + submissions.length }));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    submissions,
    setBehavior(next: MockJobBoardApiBehavior) {
      behavior = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
