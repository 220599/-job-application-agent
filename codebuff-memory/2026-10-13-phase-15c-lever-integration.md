# Phase 15C — Lever submission integration (COMPLETE, 2026-10-13)

Earlier phase history is untouched; this note appends Phase 15C only.

## What was done

- Verified the official Lever contract from Lever's own developer
  documentation (hire.lever.co/developer/documentation): the employer-
  authorized **Apply API** (`POST /v1/postings/:posting/apply`, Basic auth
  with an employer-issued API key from Settings → Integrations → API
  Credentials), plus `GET /v1/postings/:posting/apply` (question schema)
  and `POST /v1/uploads` (temp upload, ≤30MB, valid 24h, formats
  pdf/doc/docx/txt/js/jpg/png). Public Postings API is discovery-only and
  is never treated as a submission channel. Full analysis:
  `packages/lever/docs/lever-integration.md`.
- New non-browser Apply API client (`packages/lever/src/apply-api.ts`):
  documented request/question mapping, `201 + data.applicationId` as the
  ONLY acceptance evidence, documented error semantics (400/401/403/404
  definitive refusals; 429 documented as "creates no application", so a
  definitive not-submitted), bare 2xx / 5xx / mid-request failures →
  `SUBMISSION_UNCONFIRMED` (UNKNOWN, never retried). No retry anywhere;
  redirects never followed (`redirect: 'manual'`); SSRF-guarded base URL
  (fixed api.lever.co, loopback-only override for mock fixtures); no PII,
  answers, resume content, or keys in logs/results/errors.
- Path selection (`apply-submission.ts`): `LEVER_API` when
  `JAA_LEVER_API_KEY` is configured and target policy passes, else
  `BROWSER_FORM` fallback with a recorded reason (never silent).
- `real-submission.ts`: REAL browser path for Lever (native dropdowns,
  challenge detection — CAPTCHA/MFA detected and stopped, never solved).
- Policy (`packages/core/src/submission-policy.ts`): `JAA_REAL_LEVER_SUBMISSION_ENABLED`
  server-only capability flag (default off, fail closed, no client can set
  it); Lever real targets pass the same public-URL/SSRF policy as
  Greenhouse. Greenhouse behavior unchanged.
- Adapter wiring through the existing `submitApplication` boundary;
  queue/worker/persistence flow reused unchanged (no parallel pipeline).
- Mock fixtures + tests: `mock-lever-api.ts` (documented behavior switchable
  per test), 64 Lever package tests, 14 policy tests, and a dedicated
  13-scenario Lever submission E2E (`submission-lever-api-e2e.test.ts`)
  driving the real API router → BullMQ → real submission worker → adapter →
  documented client → local mock provider.

## Fixes during suite bring-up

- Mock API fixture accumulates requests/uploads/submissions across tests →
  added `reset()` + per-test reset in `beforeEach` (assertions prove exact
  per-test request counts).
- Test 5: `answerAndApprove` re-answered the skipped Email question →
  call `answerAllRequiredQuestions` + `approve` directly (matches the
  Greenhouse safety-suite pattern).
- Test 2: a fresh submit after an UNKNOWN outcome is refused at the API
  (`409 SUBMISSION_OUTCOME_UNKNOWN`, no second job) — asserted that
  contract instead of a queued-then-refused job.
- Test 11: mock form records `{path, body: <json string>, accepted}` —
  the envelope is `JSON.parse(entry.body)`.

## Verification (exact commands + exit codes, 2026-10-13)

| Command | Result | Exit |
|---|---|---|
| `npm test --workspaces` | 506 passed: api 300 (18 files), greenhouse 109 (4), lever 64 (3), browser 19 (2), ats 14 (1) | 0 |
| `npx vitest run` in `packages/lever` | 64 passed (3 files) | 0 |
| `npx vitest run` in `packages/ats` | 14 passed (1 file) | 0 |
| `npx vitest run --config vitest.e2e.config.ts tests/e2e/submission-lever-api-e2e.test.ts` (in apps/api) | 13 passed (dedicated Lever submission E2E) | 0 |
| `npx vitest run --config vitest.e2e.config.ts` (in apps/api, full mock E2E) | 61 passed (8 files) | 0 |
| `npm run type-check --workspaces` | clean | 0 |
| `npm run build --workspace apps/web` | production build OK | 0 |
| `git diff --check` | clean | 0 |

Notes: `packages/core` and `apps/worker` have no test scripts/files of
their own — their behavior is covered by the apps/api suites and the E2E
runs above (the real submission worker executes in the E2E pipeline).
Aggregate `npm run lint` remains the known pre-existing repository
limitation and was not changed.

## Safety confirmations

- No live application was submitted; no live Lever employer was contacted.
  All tests use loopback mock fixtures and synthetic candidate data only.
- Real submission stays disabled by default (`JAA_REAL_LEVER_SUBMISSION_ENABLED`
  unset/false); the mock boundary (`JAA_ALLOW_MOCK_SUBMISSION`, loopback
  only, never in production) is unchanged.
- Exactly one submission request per attempt; no retry of the apply POST
  anywhere; persisted at-most-once transmission; UNKNOWN outcomes are
  never resolved by resubmission (409 at the API).
- CAPTCHA/security challenges detected, never solved or bypassed;
  redirects never followed; SSRF guard never relaxed; credentials never
  logged.
- Greenhouse functionality and its tests untouched (all pass).
- Nothing committed or pushed (working tree only).

## Remaining / blockers to authorized live testing

- An employer-issued Lever API key (Super Admin, Settings → Integrations →
  API Credentials, "Apply to a posting") must be configured by the
  customer; we never acquire credentials.
- Lever documents no applicant-facing verification/lookup endpoint, so
  UNKNOWN outcomes cannot be auto-resolved — a provider limitation.
- No gated "real Lever" suite exists yet (Greenhouse's
  `test:greenhouse:real` pattern can be mirrored only when an authorized
  target + key exist and live submission is explicitly approved).
