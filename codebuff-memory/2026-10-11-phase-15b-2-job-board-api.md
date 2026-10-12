# Phase 15B.2 — Greenhouse Job Board API orchestration integration (COMPLETE)

Constraints (user): no live submissions; `JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED` stays off; no real candidate data / employer credentials; do not weaken approval, CAPTCHA, SSRF, idempotency, or unknown-outcome protections; no Phase 15C, no Lever submission, no unrelated UI/infra changes; do not commit or push; vendor logic in `packages/greenhouse`, generic policy in core/ats; single submission pipeline; never fabricate answers; never bypass CAPTCHA.

## What was done
- Wired `packages/greenhouse/src/job-board-api.ts` into application orchestration via `job-board-submission.ts` + `adapter.ts` (`submitViaJobBoardApi`), selected per application by `selectGreenhouseSubmissionPath` (JOB_BOARD_API vs BROWSER_FORM, never silent — fallback reason recorded on the attempt).
- `@jaa/ats`: `HTTP_ACCEPTED` evidence kind, `AtsSubmissionResult.transport`, `AtsFieldFill.label`/`externalFieldId`. Verified SUBMITTED persists `confirmationId/confirmationMethod/httpStatus/transport/warnings`; bare 2xx on other channels is never claimed as success.
- `packages/core/application-submission.ts`: warnings/transport persistence, fieldFills identity (label vs semantic precedence — label match wins; `question_71000003` gets Preferred-First-Name answer), ERROR/SUBMISSION_OUTCOME_UNKNOWN events, retryable metadata (REJECTED retryable iff httpStatus>=500 -> TRANSIENT_FAILURE else SUBMISSION_FAILED).
- Enablers: `ORCHESTRATION_ERROR_STATUS` exported from `apps/api/src/routes/applications.ts`; `closeAfterQuestions` option in `packages/greenhouse/tests/fixtures/mock-job-board-api.ts` (GET questions -> `connection: close` + `server.close()` -> subsequent POST gets deterministic ECONNREFUSED = pre-transmission "never transmitted").
- New E2E suite `apps/api/tests/e2e/submission-job-board-api-e2e.test.ts` — 17 scenarios covering: PROVIDER_ID + HTTP_ACCEPTED evidence and request/body assertions, empty/malformed 2xx bodies, 422 refusal, 401 credential refusal (key-leak assertions), required-missing 422, strict-question violation (never fabricated), empty resume, bad extension, connection-refused "never transmitted" (attemptsMade 1, marker resolved), destroy -> SUBMISSION_OUTCOME_UNKNOWN (marker unresolved, 1 attempt), crash-after-submit (1 submission, attemptsMade 2, fresh job refused), idempotency, fallback reasons, fail-closed unsafe URLs, CAPTCHA + error-status map.

## Fixes during suite bring-up
1. `answerAndApprove` now tolerates forms lacking an Email question (via shared `findQuestion`); `/submit-no-confirmation` minimal page has only First Name + submit.
2. Scenario 13 asserted `jobBoardApi.requests` length 0 un-sliced, but `jobBoardApi` is a suite-level fixture shared across tests (16 earlier requests). Fixed to snapshot `jbReqBefore` and assert `requests.slice(jbReqBefore)` has length 0, matching every other scenario.

## Verification (exact commands + exit codes)
- `cd apps/api && npx vitest run --config vitest.e2e.config.ts tests/e2e/submission-job-board-api-e2e.test.ts` -> **EXIT=0, 17 passed (17)** (earlier run before fixes: EXIT=1, 1 failed | 16 passed).
- Earlier in phase: `packages/greenhouse` 4 files / 106 tests exit 0; `application-submission-modes.db.test.ts` 4/4 exit 0 (MOCK envelope keys exactly `applicationId, fieldCount, kind, provider, requiredAnswerCount, submissionAttemptId`).
- Docker jaa-postgres + jaa-redis confirmed running for e2e.

## Safety confirmations
- No live submission; `test:greenhouse:real` NOT run; real submission default-off unchanged.
- No employer Job Board API key exists for this SaaS — integration fails safely (BROWSER_FORM fallback with recorded reason, or credential SUBMISSION_FAILED). Docs describe authorized employer setup (`packages/greenhouse/docs/greenhouse-integration-options.md` §2.2-2.4).
- CAPTCHA detection-only, SSRF guard (loopback fixture bases only), no fabricated answers, single pipeline — all unchanged and covered by the suite.

## Tooling gotcha
`code_search` (ripgrep) broke repeatedly this phase (`rg.exe` missing at `C:\Users\shubh\.config\manicode\rg.exe`); terminal `grep -rn` used as fallback. Also: always capture exit codes directly to a file (`echo "EXIT=$?"`) — `| head`/`| tail` truncation previously produced misleading exit codes (1, 127).

## Remaining (this phase's final steps)
Full battery with exact exit codes (type-check, unit tests, e2e, web build, lint) + final report.

## Phase 15B.2.1 audit (2026-10-12) — PASS, ready for Phase 15C
Evidence-based audit of the whole submission pipeline. Contract re-verified against grnhse/greenhouse-api-docs (`_applications.md`): POST endpoint is the documented "submit a new application" channel, response body undocumented, auth = Basic key from employer's API Credentials page. `HTTP_ACCEPTED` is grounded and produced ONLY at `adapter.ts` Job Board API ACCEPTED mapping; bare 2xx on any other channel stays UNCONFIRMED/UNKNOWN.

Defects found + fixed (with regression tests in `packages/greenhouse/tests/job-board-api.test.ts`):
1. **SSRF/PII via HTTP redirects** (both `fetch` calls defaulted to `redirect: 'follow'`): a 307/308 could re-send the application body (candidate data + resume) to another host, and a redirect chain could turn a non-evidence 3xx into a false "accepted" 2xx. Fixed: `redirect: 'manual'` on submit + questions fetches; 3xx on submit = thrown SUBMISSION_UNCONFIRMED (UNKNOWN, never followed); 3xx on questions = INSPECTION_FAILED. Mock fixture gained a `'redirect'` behavior + `redirectTarget` option; tests assert zero requests reach the redirect target.
2. **Provider-id fallthrough**: `parsed.id ?? parsed.application_id` let an empty-string `id` mask a valid `application_id`. Fixed: exported pure `extractGreenhouseJobBoardReference` — first valid scalar wins, only finite numbers / non-empty strings ≤ 255 chars are ever stored; nothing invented.
3. `.env.example` lacked `JAA_GREENHOUSE_JOB_BOARD_API_KEY` / `JAA_GREENHOUSE_JOB_BOARD_API_BASE` documentation — added (with TEST-ONLY loopback-only base note).

Crash recovery verified DB-backed: ApplicationEvent ledger (`SUBMISSION_STARTED`/`COMPLETED`/`FAILED`), claim = atomic `updateMany` status transition + marker in the same transaction (multi-process safe). Correct claim: at-most-once external transmission + honest UNKNOWN on ambiguity — NOT provider-side exactly-once (Job Board API has no idempotency key).

Lint remains unresolved (pre-existing): NO ESLint config exists anywhere (`eslint src` → "No files matching"; `next lint` → interactive setup prompt); `@typescript-eslint` is hoisted in node_modules (via eslint-config-next) so a minimal root `.eslintrc` + per-workspace lint scripts is feasible as a separate cleanup task. Not implemented here (no unrelated infra changes).

Final battery (2026-10-12): type-check 0; unit 0 (572 tests: api 297, browser 19, ats 14, greenhouse 109, lever 33); dedicated Job Board API E2E 0 (17/17); full E2E 0 (7 files/48 tests); web build 0; `git diff --check` 0 (CRLF-normalization stderr warnings only). Nothing committed/pushed; `test:greenhouse:real` not run.
