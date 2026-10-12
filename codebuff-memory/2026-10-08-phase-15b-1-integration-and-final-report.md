# Phase 15B.1 — completion session: non-browser path + final report (2026-10-08)

Continues `2026-10-08-phase-15b-1-hardening.md` (hardening work verified present in
code) and `2026-10-08-greenhouse-real-suite-run.md` (Formlabs run). Constraints
unchanged: mock fixtures only, no live submission, no real customer data,
real submission stays disabled by default, no commit/push, no Phase 15C.

## What was added this session (non-browser integration path, task item 6)
- `packages/greenhouse/src/job-board-api.ts`: documented Greenhouse **Job Board
  API** submission client (`submitGreenhouseJobBoardApplication`,
  `fetchGreenhouseJobBoardQuestions`, `findUnansweredRequiredQuestions`,
  `validateGreenhouseJobBoardApplication`, `buildGreenhouseJobBoardRequestBody`,
  `resolveJobBoardApiBase`). Key properties:
  - POST `https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}`, Basic
    Auth username = employer-issued Job Board API key (documented); key never
    logged/echoed; JSON body with base64 `resume_content` (approved resume only).
  - Client-side required-field validation BEFORE send (documented rule:
    Greenhouse does NOT reject missing required fields) -> `BLOCKED`, zero
    requests. Documented validations enforced (first/last/email required ≤255,
    no URLs in first/last/phone, email format, attachment types pdf/doc/docx/txt/rtf).
  - Outcomes: `ACCEPTED` (2xx; `reference` null unless provider returns an id —
    response body is undocumented), `REFUSED` (4xx definitive), `BLOCKED`
    (nothing sent), thrown `SUBMISSION_UNCONFIRMED` (network/5xx = unknown,
    never retried). Exactly ONE POST per call — no retry (no idempotency key).
  - SSRF guard: fixed API host or loopback mock base only
    (`BLOCKED_BY_SECURITY_POLICY` otherwise, before any connection).
- `packages/greenhouse/tests/fixtures/mock-job-board-api.ts`: local mock of the
  documented endpoint (auth 401, documented 422 validations incl. field-type
  match, 200 with/without id, 500, socket destroy; records every request).
- `packages/greenhouse/tests/job-board-api.test.ts`: 23 tests (all pass).
- `packages/greenhouse/src/index.ts`: exports the new module.
- `packages/greenhouse/docs/greenhouse-integration-options.md`: the documented
  options analysis (A Job Board API / B Harvest API / C embedded browser form /
  D custom form→API), what is supported for our use case, **Formlabs rejection
  analysis**, remaining blockers, preserved invariants.

## Options determination (task items 3+6)
- Candidate-side apply to arbitrary employers: only browser path C; CAPTCHA
  (invisible reCAPTCHA Enterprise) stops submission when active — detected,
  never solved/bypassed. Platform boundary.
- Employer-authorized: Job Board API (A) — challenge-free, documented,
  implemented+tested (needs employer-issued Job Board API key). Harvest API
  "Add Application to Candidate/Prospect" (`POST harvest.greenhouse.io/v1/candidates/{id}/applications`)
  — employer-account import only (Harvest key), not a candidate-side apply.

## Formlabs rejection cause (task item 4) — final determination
REJECTED verdict = visible validation refusal with form present (definitive,
nothing submitted). Causes separated: (1) direct = ordinary client-side
validation errors; (2) root = missing required fields — required Resume (suite
never uploads files) + react-select comboboxes left unfilled (fill-script
`sel.options` crash, fixed; grounded combobox fill added in 15B.1); (3) CAPTCHA
present (reCAPTCHA Enterprise) but NOT the cause of this rejection — with the
15B.1 settle gate the same target now stops at CHALLENGE_DETECTED before submit.
Documented in `docs/greenhouse-integration-options.md` §4.

## Verification (exact commands + exit codes, 2026-10-08)
1. `npm run type-check --workspaces` -> exit 0.
2. `npm test --workspaces` -> exit 0 (api 18 files/297 tests, browser 2/19,
   ats 1/14, greenhouse 3/91 incl. 23 new job-board-api tests, lever passed;
   workspaces without a `test` script print `npm ERR! Missing script: test` but
   contribute no failures).
3. `npm run test:e2e` (jaa-postgres + jaa-redis up) -> exit 0; 6 files / 31
   tests, incl. submission-safety-e2e (approval gate, unapproved-resume block,
   challenge stop, SSRF, bounded retry, crash-retry -> exactly 1 submission).
4. `cd apps/web && npm run build` -> exit 0.
5. `cd apps/api && npx vitest run tests/submission-policy.test.ts` -> exit 0,
   11/11 (real submission disabled by default). Note: one earlier run of this
   same command exited 139 from an npx-wrapper segfault AFTER vitest reported
   11/11 passed; clean re-run exit 0 (Windows npx teardown flake, not a test
   failure).
6. `cd packages/greenhouse && npx vitest run tests/job-board-api.test.ts` ->
   exit 0, 23/23; full greenhouse suite 3 files / 91 tests exit 0 earlier.
7. `test:greenhouse:real` NOT run. No live targets touched.

## Safety confirmations
Only loopback mocks; CAPTCHA detection-only untouched; no security control
weakened; real submission disabled by default; SSRF guard added for the new
client; PII-free results (sentinel-tested); nothing committed/pushed; Phase 15C
not started. Open follow-ups: wire Job Board API client into
application-submission/worker (needs per-board credential storage + a possible
`HTTP_ACCEPTED` confirmation kind in @jaa/ats), Harvest path for employer-side
integrations.
