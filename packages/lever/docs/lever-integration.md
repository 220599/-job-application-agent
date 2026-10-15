# Lever submission integration — Phase 15C

This document records which Lever application-submission mechanisms are
**officially documented and authorized**, what we implemented against them,
and what remains blocked. Nothing here is invented: every endpoint, status
code, and limit below comes from Lever's own developer documentation
(hire.lever.co/developer/documentation — "Apply to a posting", "Retrieve
posting application questions", "Uploads", and API Overview "Responses and
Errors" / "Supported File Formats").

## 1. Verified Lever API capabilities

### 1.1 Public posting discovery (unauthenticated)

`GET https://api.lever.co/postings/:site` (the public Postings API) serves
job postings for a Lever careers site. It is a **discovery** API only —
it does NOT authorize application submission. We never treat a public
posting endpoint as a submission channel.

### 1.2 Application submission — the documented, employer-authorized path

Lever documents an official apply endpoint (hire.lever.co/developer
/documentation, "Apply to a posting"):

```
POST https://api.lever.co/v1/postings/:posting/apply
Authorization: Basic <base64 of "{API_KEY}:" (key as username, blank password)>
```

- **Authentication:** an employer-issued API key created by a Super Admin
  of the employer's Lever account on **Settings → Integrations → API
  Credentials**. OAuth exists only for registered partner integrations and
  is not used here. No public/anonymous submission path exists — by design.
- **Companion endpoints used by the client:**
  - `GET /v1/postings/:posting/apply` — "Retrieve posting application
    questions": the ordered question schema (custom question sets,
    personal information, urls, EEO) that the POST body must match exactly.
  - `POST /v1/uploads` — temporary file upload (multipart/form-data,
    ≤ 30 MB, valid 24 h) whose returned `uri` the application references.
    Documented as available to any key that has "Apply to a posting".
- **Supported resume formats** (API Overview): pdf, doc, docx, txt, js,
  jpg, png.
- **Documented success semantics (the ONLY acceptance evidence):**
  `201 Created` with `{"data":{"applicationId":"<uid>"}}`. The id can be
  used to view the candidate profile in Lever.
- **Documented error semantics:** 400 invalid request, 401 missing/invalid
  key, 403 account settings do not authorize the operation, 404 unknown
  object, 429 rate limited, 500/503 provider errors.
- **Rate limits:** token bucket, 10 req/s steady per API key. The Postings
  API documents that a **429'd application POST creates NO application**
  ("retry all requests that receive a 429 or the applicant is lost").

### 1.3 What is NOT documented / not available

- There is **no idempotency key** on the apply endpoint and **no
  candidate-facing verification/lookup endpoint** for an application by
  the applicant. So an ambiguous outcome can never be auto-resolved and
  must never be retried blindly (see §5).
- Browser automation of the public apply form is NOT an authorized
  equivalent of the API path (see §6).

## 2. Required authorized setup

1. The employer (customer) creates an API key on their Lever account:
   Settings → Integrations → API Credentials (Super Admin only), with
   access to "Apply to a posting".
2. The key is configured **server-side only** via `JAA_LEVER_API_KEY`.
   It is never exposed to the browser, never logged, and never included
   in events, runs, queue payloads, or error messages.
3. Real submission additionally requires the server-side capability flag
   `JAA_REAL_LEVER_SUBMISSION_ENABLED=true` (§3). Both are disabled by
   default.

We do not acquire, invent, or generate employer credentials.

## 3. Environment configuration and feature flags

| Variable | Purpose | Default |
|---|---|---|
| `JAA_LEVER_API_KEY` | Employer-issued Lever API key (server-side secret). Empty ⇒ submission falls back to the application-form path with a recorded reason (never silent). | empty |
| `JAA_LEVER_API_BASE` | **TEST-ONLY** base-URL override for local mock fixtures. Accepted ONLY for loopback hosts; anything else is refused by the SSRF guard before a connection is opened. | `https://api.lever.co` |
| `JAA_REAL_LEVER_SUBMISSION_ENABLED` | Server-only capability flag for real (non-loopback) Lever submission. Exactly `true` enables it; a client can never set it. | `false` (disabled) |

### Path selection (server-side only, never a client choice)

- **LEVER_API** — chosen when `JAA_LEVER_API_KEY` is configured and the
  target policy passes (real targets require `JAA_REAL_LEVER_SUBMISSION_ENABLED=true`
  plus the public-URL/SSRF policy; loopback mock targets require the
  Phase 15A mock opt-in). Uses the documented Apply API.
- **BROWSER_FORM** — fallback when no API key is configured. The exact
  fallback reason is recorded on the attempt (e.g. `JAA_LEVER_API_KEY`
  not configured). Browser submission never bypasses approval, resume
  validation, or the submission policy.

## 4. Evidence required for each submission outcome

| Outcome | Evidence (contract-grounded) | Persisted result |
|---|---|---|
| Authoritatively accepted | `201` **with** documented `data.applicationId` | `SUBMITTED`, `externalApplicationId` = the documented id (PROVIDER_ID evidence) |
| Definitive rejection | Documented refusal: 400/401/403/404, and 429 (documented: a 429'd apply POST **creates no application**) | `FAILED`, `SUBMISSION_FAILED` — never retried |
| Known pre-transmission failure | Validation refused before any request: missing/unapproved required answers, unsupported resume format (>30 MB or not pdf/doc/docx/txt/js/jpg/png), security policy | `FAILED`, nothing transmitted |
| Security challenge | CAPTCHA / MFA / anti-bot challenge detected on the browser path | `FAILED`, `CAPTCHA_DETECTED` / `SECURITY_CHALLENGE` — **detected, never solved or bypassed** |
| Ambiguous outcome | Bare 2xx **without** the documented `applicationId`, 5xx, empty/malformed body, or a connection failure **after** the request may have reached Lever | `FAILED`, `SUBMISSION_OUTCOME_UNKNOWN` — never claimed as success, never retried |

A generic 2xx is therefore **never** acceptance evidence: only the
documented `201 + data.applicationId` is.

## 5. Retry and duplicate-prevention semantics

- **Exactly one submission request per attempt.** The apply endpoint has
  no idempotency key, so the client performs a single request and NEVER
  retries it — not on timeout, not on 5xx, not after a restart.
- **Persisted at-most-once transmission.** The durable attempt ledger
  (Prisma) is claimed before transmission; a worker crash after
  transmission is recovered from the database and can never cause a
  second request. Duplicate submit API calls and duplicate queue jobs
  collapse into one effective submission.
- **Unknown outcomes stay unresolved.** Re-submitting an application with
  an unknown outcome is refused at the API (`409 SUBMISSION_OUTCOME_UNKNOWN`)
  — no second job, no second request — until a safe verification path
  exists (Lever documents none for applicants today).
- **Redirects are never followed** (`redirect: 'manual'`): a redirect
  could re-send the application body (candidate data, resume) to another
  host or forge a false "accepted" 2xx away from the documented endpoint.
  Cross-host redirects are recorded as failures, never forwarded.
- **SSRF guard:** the request goes to exactly one endpoint — the fixed
  `api.lever.co` base or, for local mock fixtures only, a loopback base.
  Any other base is refused before a connection is opened.

## 6. Known limitations and unresolved provider requirements

- **No verification endpoint.** Lever documents no applicant-facing lookup
  for an application, so `SUBMISSION_OUTCOME_UNKNOWN` cannot be resolved
  automatically. This is a provider limitation, not an implementation gap.
- **Browser automation is not an authorized submission channel.** The
  BROWSER_FORM fallback automates the public apply form for mock/loopback
  targets and controlled operation; it does not substitute for employer
  authorization and is subject to any CAPTCHA / anti-bot challenge on the
  live form (detected and stopped, never bypassed).
- **Rate limiting.** 10 req/s steady per API key (token bucket). The
  single-request-per-attempt design stays far below this.
- **Registered-partner OAuth** exists but is out of scope; we use only the
  employer-issued API key the customer configures.

## 7. Mock test commands (local only — never touches Lever)

All suites below use loopback mock fixtures and synthetic candidate data
only; no live employer is ever contacted and no real application is ever
submitted.

```bash
# Lever package unit + contract tests (Apply API client, path selection,
# answer mapping, browser DOM scan):
npm run test -w @jaa/lever

# Dedicated Lever submission E2E (real API router -> queue -> worker ->
# adapter -> documented Apply API client -> local mock provider), 13
# scenarios: success evidence, bare-2xx UNKNOWN, 422/401 refusals,
# missing answers, bad resume format, connection failure, crash recovery,
# duplicate collapse, form fallback, fail-closed REAL targets, CAPTCHA:
npm run test:e2e -w @jaa/api -- tests/e2e/submission-lever-api-e2e.test.ts

# Lever browser-path E2E (mock form, DOM prep + mock submission boundary):
npm run test:e2e -w @jaa/api -- tests/e2e/lever-e2e.test.ts tests/e2e/submission-lever-e2e.test.ts

# Full mock E2E suite (all providers):
npm run test:e2e -w @jaa/api
```

Real submission remains **disabled by default** and no gated "real Lever"
suite exists — live testing requires the authorized employer setup in §2
and is a separate, explicitly approved step.
