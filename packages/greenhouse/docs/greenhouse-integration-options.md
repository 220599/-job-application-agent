# Greenhouse submission options — Phase 15B.1 investigation + 15B.2 integration

Status: investigated and tested against **local mock fixtures only**. No live
submission was made, no real customer data was used, and real submission
remains disabled by default (`JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED` unset).
This document exists so we stop assuming every submission must go through
browser automation.

**Phase 15B.2 update:** the Job Board API client (path A) is now wired into
the production submission pipeline as one of two Greenhouse submission paths,
selected per application (see §2.4). Path selection is never silent: when the
API path cannot be used, the browser-form path runs and the fallback reason is
recorded on the submission attempt. Evidence semantics and authorized
employer setup are documented in §2.2 and §2.3.

Sources: Greenhouse official docs —
[Job Board API](https://docs.greenhouse.io/job-board.html) and
[Harvest API](https://docs.greenhouse.io/harvest.html) (grnhse/greenhouse-api-docs).

## 1. The four ways an application can reach a Greenhouse account

| # | Path | Auth required | Browser / CAPTCHA | Supported for us? |
|---|------|--------------|-------------------|-------------------|
| A | **Job Board API — "Submit an application"** `POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}` | Job Board API key (HTTP Basic, username = key), **issued by the employer** on their Greenhouse *API Credentials* page | None — pure HTTP, no CAPTCHA on this channel | **Yes, when the employer authorizes us with a key.** Implemented + tested in `src/job-board-api.ts` |
| B | **Harvest API — "Add Application to Candidate/Prospect"** `POST https://harvest.greenhouse.io/v1/candidates/{id}/applications` | Harvest API key, **issued by the employer's Greenhouse admin** (partner/Marketplace-style integration) | None | Only for employer-side integrations. It writes into an employer's own account for an existing candidate — it is not a candidate-side "apply anywhere" method |
| C | **Embedded Job Application** `job-boards.greenhouse.io/embed/job_app` (incl. custom-domain boards like `careers.formlabs.com` that wrap it in `#grnhse_iframe`) | None (public) | Browser automation — **carries Greenhouse's built-in spam protection (invisible reCAPTCHA Enterprise)** | Yes for form filling/inspection; a submission only completes when no challenge is active. Challenges are detected and stopped — **never solved, bypassed, or waited out** |
| D | Custom career-site form POSTing to the Job Board API (the "build your own form" path) | Same key as (A) | None | Same as (A). Greenhouse explicitly discourages it: "we would encourage customers to make use of the Embedded Job Application … our application form is well tested … and has built-in spam protection" |

### What this means for our product goal (maximize legitimate automation)

- **Candidate-side applies to arbitrary employers (no employer relationship):**
  only path C exists. It is fully automated up to whatever the target permits;
  when a CAPTCHA/security challenge is active, the permitted automation stops
  there and hands the step to the human. That is a platform boundary, not a
  missing feature — and we do not cross it.
- **Employer-authorized applies (partnerships, integrations, our own job
  boards, employer-provided credentials):** path A is the documented,
  challenge-free submission channel. It avoids browser-based challenges
  *legitimately* — because the employer authorized the channel, not because a
  challenge was evaded. Path B covers employer-account imports.

## 2. Path A (Job Board API) — implemented and tested

Implementation: `packages/greenhouse/src/job-board-api.ts`
(`submitGreenhouseJobBoardApplication`, `fetchGreenhouseJobBoardQuestions`,
`findUnansweredRequiredQuestions`, `validateGreenhouseJobBoardApplication`).
Tests: `packages/greenhouse/tests/job-board-api.test.ts` against the local
mock `tests/fixtures/mock-job-board-api.ts`.

Documented behaviors encoded:

- **Auth:** HTTP Basic over TLS, username = the board's Job Board API key,
  no password. The key is a secret that must stay server-side (Greenhouse's
  own docs warn that exposing it in client-side form posts "would be a very
  bad thing"). We use it for exactly one Authorization header and never log it.
- **Mandatory client-side validation:** "Greenhouse will not confirm the
  inclusion of required fields. Validation for required fields must be done on
  the client side, as Greenhouse will not reject applications that are missing
  required fields." So the client validates before sending and refuses
  (`BLOCKED`, zero requests) instead of silently producing a partial
  application. Required coverage comes from the documented question list
  (`GET /v1/boards/{board}/jobs/{id}?questions=true`, public, read-only).
- **Documented request validations enforced client-side:** `first_name`,
  `last_name`, `email` required and ≤ 255 chars; no URLs in
  first/last/phone; valid email; attachments only pdf/doc/docx/txt/rtf and
  > 0 bytes. Provider-side 422 (e.g. "field values must match the field type
  specified on the job post question") is treated as a definitive refusal.
- **Attachments:** base64 `resume_content` + `resume_content_filename` (the
  documented JSON upload method); approved resume only.
- **Outcome model (asymmetric-safe, same doctrine as the browser path):**
  - `ACCEPTED` — provider answered 2xx on the documented submission endpoint
    (authenticated provider acceptance). The response body is **not
    documented**, so `reference` is null unless the provider returns an id.
  - `REFUSED` — provider answered 4xx: definitive, nothing was submitted.
  - `BLOCKED` — client-side validation/credentials refused the attempt before
    any request: definitive, nothing was sent.
  - thrown `SUBMISSION_UNCONFIRMED` — network failure mid-request or a 5xx:
    the outcome cannot be proven either way and **must never be retried
    blindly**.
- **No retry anywhere.** The endpoint has no idempotency key and no documented
  deduplication, so exactly one POST is issued per attempt; single-attempt
  enforcement stays in the caller's durable attempt ledger
  (`SUBMISSION_STARTED` blocks any new attempt while unresolved).
- **SSRF guard:** the request goes to the fixed `boards-api.greenhouse.io`
  host, or a loopback base URL for local mock fixtures only. Anything else
  (metadata endpoints, internal hosts, arbitrary remotes) is refused before a
  connection is opened, and HTTP redirects are **never followed**
  (`redirect: 'manual'`) - a redirect could otherwise re-send the
  application body to another host or turn a non-evidence 3xx into a false
  "accepted" 2xx. A 3xx answer is an UNKNOWN outcome.

### 2.2 Evidence semantics (Phase 15B.2)

The Job Board API response body is undocumented, so the only trustworthy
signal is the HTTP status on the documented submission endpoint:

- **`PROVIDER_ID`** — the response contains a parseable `id` /
  `application_id`; recorded as `externalApplicationId`.
- **`HTTP_ACCEPTED`** — 2xx without a parseable id: the provider accepted the
  application (`confirmationMethod: 'HTTP_ACCEPTED'`, `transport: 'API'`),
  `externalApplicationId` stays null. This is a *verified* SUBMITTED outcome —
  authenticated provider acceptance is the documented contract.
- Anything else never upgrades to SUBMITTED: 401–403 → definitive
  `SUBMISSION_FAILED` ("refused the configured employer credentials"), other
  4xx → `REJECTED`, 5xx / mid-request failure → thrown
  `SUBMISSION_UNCONFIRMED` → durable **UNKNOWN** outcome (marker left open,
  never retried). Pre-transmission connection failures (refused / DNS /
  connect-timeout) are proven "never transmitted" and fail as definitive
  `SUBMISSION_FAILED` without an open marker.

### 2.3 Authorized employer setup

Path A only works with a key **issued by the employer** — it is an authorized
integration channel, not a way to bypass anything:

1. The employer's Greenhouse admin creates a Job Board API key on their
   Greenhouse **API Credentials** page ("Job Board API" type).
2. The key is configured server-side as `JAA_GREENHOUSE_JOB_BOARD_API_KEY`.
   It is used for exactly one Authorization header, never logged, and never
   exposed to the browser.
3. `JAA_GREENHOUSE_JOB_BOARD_API_BASE` is a **TEST-ONLY** loopback override
   for local mock fixtures. In production the base is fixed to
   `https://boards-api.greenhouse.io` (SSRF guard refuses anything else).

Without a configured key there is no fail-open: `selectGreenhouseSubmissionPath`
records "No employer-issued Job Board API key is configured…" and the
browser-form path runs instead. **No key exists for this SaaS today**, so all
tests exercise the API path against loopback mock fixtures only.

### 2.4 Path selection (never silent)

`selectGreenhouseSubmissionPath(url, env)` chooses per application:

- **`JOB_BOARD_API`** — only when the application URL exposes the documented
  board shape (`/{board_token}/jobs/{id}`), credentials are configured, and
  (in mock mode) the fixture base is loopback.
- **`BROWSER_FORM`** — otherwise, with the specific reason recorded on the
  submission attempt: unparseable URL, missing employer key, or mock mode
  without a loopback fixture base. The user can always see why the API path
  was not used; it is never skipped silently.

Both paths share the single submission pipeline (durable attempt ledger,
one attempt, unknown-outcome protection, approved-resume-only, no fabricated
answers).

## 3. Path B (Harvest API) — documented, not applicable to candidate-side applies

`POST https://harvest.greenhouse.io/v1/candidates/{id}/applications` requires a
Harvest API key provisioned by the employer's Greenhouse admin (a
partner-style integration), and an existing candidate in that employer's
account. It is the right channel for employer-side automation (e.g. an
employer asks us to import applications) and also avoids browser challenges —
but it cannot be used to apply on behalf of a candidate to a third-party
employer without that employer's credentials. No implementation this phase.

## 4. What caused the Formlabs attempt to be rejected (2026-10-08)

The gated real run against `careers.formlabs.com` (custom-domain board,
form in the Greenhouse embed iframe) ended **REJECTED — "the form actively
refused the submission (visible validation errors); nothing was submitted"**
and the suite asserted `externalApplicationId` is null. Zero applications
were submitted. Cause analysis, separated by category:

1. **Ordinary validation errors — the direct cause.** In our verdict model,
   `REJECTED` is only ever produced when the application form is still present
   **and** visible field-validation / required-error markers are on the page
   (`interpretGreenhouseConfirmation`: `refused && formPresent`, stable across
   several reads). The form refused the input at its own client-side
   validation; no application request was accepted.
2. **Missing required fields — the underlying cause of those errors:**
   - the required **Resume** file question was empty by construction (the
     gated test suite never uploads files — `resumeFile: null` and FILE
     fields are skipped by design);
   - the **react-select combobox questions** (country / custom / EEO
     dropdowns) were left unfilled: the fill script crashed on
     `sel.options` because combobox inputs were typed as `SELECT`. The crash
     was fixed to an honest "missed" result in that session, and Phase 15B.1
     added grounded combobox filling (open menu → read live options → select
     only an option matching the approved answer; never a default/first).
3. **CAPTCHA / security challenge — present on the form but NOT the cause of
   this rejection.** The form carries invisible reCAPTCHA Enterprise
   (`[name="g-recaptcha-response"]`, `iframe[src*=recaptcha]`). The rejection
   happened at client-side validation before any request, so the CAPTCHA was
   never the blocking step in *this* attempt. It is nevertheless a standing
   blocker: with the Phase 15B.1 challenge-settle gate (bounded re-scan before
   the final submit action, closing the async-load timing gap), the same
   target is now correctly stopped as `CHALLENGE_DETECTED` **before** the
   submit click. Policy unchanged: challenges are detected and stop the flow —
   never solved, spoofed, or routed through third-party solving services.

Conclusion: the Formlabs form was refused for **missing required fields
(ordinary validation)**, not by the CAPTCHA — and even with every field
correctly filled, the live reCAPTCHA Enterprise on that form would (correctly)
stop browser submission at `CHALLENGE_DETECTED`. Path A (employer-provided
Job Board API key) is the documented way to submit to that employer without
facing the browser challenge at all.

## 5. Remaining technical blockers

- **No employer credentials ⇒ no challenge-free path.** For arbitrary
  employers, only browser automation (path C) exists, and active
  CAPTCHA/challenge blocks submission by design.
- **Job Board API response body is undocumented.** A 2xx is provider
  acceptance but cannot promise a confirmation id. **Resolved in 15B.2:**
  `@jaa/ats` now has `HTTP_ACCEPTED` as a third confirmation-evidence kind
  (see §2.2); a 2xx is accepted as provider acceptance with a null id, and a
  bare 2xx on any *other* channel (e.g. the browser form) is never claimed as
  success without its documented confirmation.
- **No idempotency on the Job Board API.** Unknown outcomes must remain
  non-retryable; the durable attempt ledger already enforces this. A crashed
  attempt that may have transmitted is left as UNKNOWN and refused for any
  new attempt — never re-sent.
- **Orchestration wiring — done in 15B.2.** The client is connected to
  `application-submission.ts` / the submission worker through the single
  pipeline (path selection §2.4, ledger integration, evidence persistence,
  fallback reasons). Covered by the 17-scenario mock E2E suite
  `apps/api/tests/e2e/submission-job-board-api-e2e.test.ts`.
- **Greenhouse Inclusion / demographic questions and GDPR `data_compliance`**
  are documented API fields that the current client passes through as plain
  answers only; consent capture UX remains a human step.

## 6. Safety invariants preserved (verified this phase)

- Human authorization: real submission remains disabled by default
  (`JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED`, default false) and the target
  policy (`assertSubmissionTarget`) is unchanged.
- Approved-resume requirement: only the approved resume is uploaded/sent; any
  other file field stays empty with a warning.
- Answer validation: client-side required-coverage checks now also exist for
  path A (documented rule).
- Idempotency / unknown outcomes: single attempt per submission attempt id;
  unknown outcomes are `SUBMISSION_UNCONFIRMED`, never retried; unresolved
  `SUBMISSION_STARTED` blocks any new attempt.
- CAPTCHA/security challenges: detection-only; broadened markers
  (g-recaptcha/recaptcha.net, h-captcha, turnstile/challenges.cloudflare.com,
  MFA, bot challenges) incl. late-loading scripts; never solved or bypassed.
- PII: answer values, the API key, and resume content never appear in logs,
  events, warnings, or results (asserted against sentinel values in tests).
- Testing: local mock fixtures on loopback only; no live submission, no real
  customer data, `test:greenhouse:real` not run.
