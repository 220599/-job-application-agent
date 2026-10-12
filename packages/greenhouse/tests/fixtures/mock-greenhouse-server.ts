import http from 'http';
import type { AddressInfo } from 'net';

/**
 * Local mock Greenhouse server for @jaa/greenhouse tests.
 *
 * Deterministic fixture pages modeled on real Greenhouse markup - the
 * current job-boards layout (form#application-form.application--form,
 * aria-required labels, react-select comboboxes, file-upload groups) and
 * the classic boards layout (form#application_form, native selects,
 * radio/checkbox groups, job_application[...] names). Runs on an ephemeral
 * 127.0.0.1 port; never touches the network. Any form POST is recorded as
 * a submission so tests can prove that nothing is ever submitted. Every
 * request is also recorded in `requests` so tests can prove exactly what
 * was (and was not) navigated. Extra routes: /captcha (reCAPTCHA challenge
 * page for negative tests), /broken (connection killed for controlled
 * worker-failure tests), and the Phase 15A mock submission surface:
 *   POST /submit-application        - the mock ATS submission endpoint
 *     (accepts the identifiers-only MOCK_SUBMISSION envelope, answers with
 *     a verifiable confirmation; recorded with accepted=true);
 *   POST /submit-application-error - a mock ATS that refuses every
 *     submission with HTTP 500 (recorded with accepted=false);
 *   GET  /submit-fail              - application form whose action points
 *     at the error endpoint;
 *   GET  /security-challenge       - application form behind an MFA /
 *     security challenge (must stop submission, never be solved).
 */

export interface MockGreenhouseServer {
  url: string;
  /**
   * Every POST the server received (form submissions AND mock submission
   * requests). Entries carry `accepted` (true only when the mock ATS
   * confirmed the submission) and `confirmationId` when accepted. Must stay
   * empty in every preparation test.
   */
  submissions: Record<string, unknown>[];
  /** Every request the server received - proves what was/was not navigated. */
  requests: { method: string; path: string }[];
  close(): Promise<void>;
}

const MODERN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Job Application for Analytics Engineer at TestCo</title></head>
<body>
<div id="react-portal-mount-point"></div>
<main class="main job-post">
  <h1>Analytics Engineer</h1>
  <form id="application-form" class="application--form" method="post" action="/submit-application">
    <div class="application--questions">
      <div class="field-wrapper"><div class="text-input-wrapper">
        <label id="first_name-label" for="first_name" class="label">First Name*</label>
        <input id="first_name" class="input input__single-line" aria-label="First Name"
               aria-required="true" type="text" maxLength="255" autoComplete="given-name" />
      </div></div>
      <div class="field-wrapper"><div class="text-input-wrapper">
        <label id="last_name-label" for="last_name" class="label">Last Name*</label>
        <input id="last_name" class="input input__single-line" aria-label="Last Name"
               aria-required="true" type="text" maxLength="255" autoComplete="family-name" />
      </div></div>
      <div class="field-wrapper"><div class="text-input-wrapper">
        <label id="preferred_name-label" for="preferred_name" class="label">Preferred First Name</label>
        <input id="preferred_name" class="input input__single-line" aria-label="Preferred First Name"
               aria-required="false" type="text" />
      </div></div>
      <div class="field-wrapper"><div class="text-input-wrapper">
        <label id="email-label" for="email" class="label">Email*</label>
        <input id="email" class="input input__single-line" aria-label="Email"
               aria-required="true" type="text" autoComplete="email" />
      </div></div>
      <fieldset class="phone-input">
        <legend class="visually-hidden">Phone</legend>
        <div class="phone-input__country">
          <div class="select"><div class="select__container">
            <label id="country-label" for="country" class="label select__label">Country*</label>
            <div class="select-shell">
              <div class="select__input-container">
                <input class="select__input" id="country" spellcheck="false" tabindex="0"
                       type="text" aria-autocomplete="list" aria-expanded="false"
                       aria-haspopup="true" aria-labelledby="country-label"
                       aria-required="true" role="combobox" value=""
                       data-options="United States|Canada|United Kingdom" />
              </div>
            </div>
            <input required="" tabindex="-1" aria-hidden="true"
                   class="remix-css-1a0ro4n-requiredInput" value="" />
          </div></div>
        </div>
        <div class="phone-input__phone">
          <label id="phone-label" for="phone" class="label">Phone*</label>
          <input id="phone" class="input input__single-line" aria-label="Phone"
                 aria-required="true" type="tel" maxLength="255" />
        </div>
      </fieldset>
      <div class="field-wrapper">
        <div class="select"><div class="select__container">
          <label id="candidate-location-label" for="candidate-location" class="label select__label">Location (City)*</label>
          <div class="select-shell">
            <div class="select__input-container">
              <input class="select__input" id="candidate-location" tabindex="0" type="text"
                     aria-autocomplete="list" aria-haspopup="true" role="combobox"
                     aria-labelledby="candidate-location-label" aria-required="true" value=""
                     data-options="San Francisco, CA|New York, NY|Remote" />
            </div>
          </div>
          <input required="" tabindex="-1" aria-hidden="true"
                 class="remix-css-1a0ro4n-requiredInput" value="" />
        </div></div>
      </div>
      <div class="field-wrapper">
        <div role="group" aria-labelledby="upload-label-resume" aria-required="true" class="file-upload">
          <div id="upload-label-resume" class="label upload-label">Resume/CV*</div>
          <div class="file-upload__wrapper">
            <label class="visually-hidden" for="resume">Attach</label>
            <input id="resume" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" />
          </div>
        </div>
      </div>
      <div class="field-wrapper">
        <div role="group" aria-labelledby="upload-label-cover_letter" aria-required="false" class="file-upload">
          <div id="upload-label-cover_letter" class="label upload-label">Cover Letter</div>
          <div class="file-upload__wrapper">
            <label class="visually-hidden" for="cover_letter">Attach</label>
            <input id="cover_letter" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" />
          </div>
        </div>
      </div>
    </div>
    <h2>Additional Information</h2>
    <div class="application--questions">
      <div class="field-wrapper"><div class="text-input-wrapper">
        <label id="question_70000001-label" for="question_70000001" class="label">LinkedIn Profile*</label>
        <input id="question_70000001" class="input input__single-line" aria-label="LinkedIn Profile"
               aria-required="true" type="text" />
      </div></div>
      <div class="field-wrapper"><div class="text-input-wrapper">
        <label id="question_70000002-label" for="question_70000002" class="label">GitHub Profile</label>
        <input id="question_70000002" class="input input__single-line" aria-label="GitHub Profile"
               aria-required="false" type="text" />
      </div></div>
      <div class="field-wrapper"><div class="text-input-wrapper">
        <label id="question_70000003-label" for="question_70000003" class="label">Portfolio / Website</label>
        <input id="question_70000003" class="input input__single-line" aria-label="Portfolio / Website"
               aria-required="false" type="text" />
      </div></div>
      <div class="field-wrapper">
        <div class="select"><div class="select__container">
          <label id="question_70000004-label" for="question_70000004" class="label select__label">Are you authorized to work in the United States?*</label>
          <div class="select-shell">
            <div class="select__input-container">
              <input class="select__input" id="question_70000004" tabindex="0" type="text"
                     aria-autocomplete="list" aria-haspopup="true" role="combobox"
                     aria-labelledby="question_70000004-label" aria-required="true" value=""
                     data-options="Yes|No" />
            </div>
          </div>
          <input required="" tabindex="-1" aria-hidden="true"
                 class="remix-css-1a0ro4n-requiredInput" value="" />
        </div></div>
      </div>
      <div class="field-wrapper">
        <div class="select"><div class="select__container">
          <label id="question_70000005-label" for="question_70000005" class="label select__label">Will you now or in the future require sponsorship for an immigration status?*</label>
          <div class="select-shell">
            <div class="select__input-container">
              <input class="select__input" id="question_70000005" tabindex="0" type="text"
                     aria-autocomplete="list" aria-haspopup="true" role="combobox"
                     aria-labelledby="question_70000005-label" aria-required="true" value=""
                     data-options="Yes|No" />
            </div>
          </div>
          <input required="" tabindex="-1" aria-hidden="true"
                 class="remix-css-1a0ro4n-requiredInput" value="" />
        </div></div>
      </div>
      <div class="field-wrapper"><div class="text-input-wrapper">
        <label id="question_70000006-label" for="question_70000006" class="label">Tell us about yourself</label>
        <textarea id="question_70000006" class="input" aria-label="Tell us about yourself"
                  aria-required="false"></textarea>
      </div></div>
    </div>
    <div class="eeoc__container">
      <h2>Voluntary Self-Identification</h2>
      <div class="eeoc__question__wrapper">
        <div class="select"><div class="select__container">
          <label id="gender-label" for="gender" class="label select__label">Gender</label>
          <div class="select-shell">
            <div class="select__input-container">
              <input class="select__input" id="gender" tabindex="0" type="text"
                     aria-autocomplete="list" aria-haspopup="true" role="combobox"
                     aria-labelledby="gender-label" aria-required="false" value=""
                     data-options="Male|Female|Decline to self-identify" />
            </div>
          </div>
        </div></div>
      </div>
    </div>
    <div class="application--submit">
      <button type="submit" class="btn btn--pill">Submit application</button>
    </div>
  </form>
</main>
<footer class="footer">
  <a class="footer-logo-link" target="_blank" href="https://www.greenhouse.com">Powered by Greenhouse</a>
</footer>
<script>
  (function () {
    function closeAll() {
      var lists = document.querySelectorAll('[role="listbox"]');
      for (var i = 0; i < lists.length; i++) lists[i].remove();
    }
    var inputs = document.querySelectorAll('input[role="combobox"]');
    for (var i = 0; i < inputs.length; i++) {
      (function (input) {
        input.addEventListener('click', function () {
          closeAll();
          var list = document.createElement('div');
          list.setAttribute('role', 'listbox');
          var opts = (input.getAttribute('data-options') || '').split('|');
          for (var j = 0; j < opts.length; j++) {
            (function (label) {
              var item = document.createElement('div');
              item.setAttribute('role', 'option');
              item.textContent = label;
              // react-select behavior: choosing an option sets the control's
              // value and emits input/change, then closes the menu.
              item.addEventListener('click', function () {
                input.value = label;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                closeAll();
              });
              list.appendChild(item);
            })(opts[j]);
          }
          (document.getElementById('react-portal-mount-point') || document.body).appendChild(list);
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') closeAll();
        });
      })(inputs[i]);
    }
  })();
</script>
</body>
</html>`;

const CLASSIC_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Job Application for Backend Engineer at LegacyCo</title></head>
<body>
  <h1>Backend Engineer</h1>
  <form id="application_form" method="post" action="/submit-application">
    <div class="field-wrapper">
      <label for="first_name">First Name</label>
      <input id="first_name" name="job_application[first_name]" type="text" required />
    </div>
    <div class="field-wrapper">
      <label for="last_name">Last Name</label>
      <input id="last_name" name="job_application[last_name]" type="text" required />
    </div>
    <div class="field-wrapper">
      <label for="email">Email</label>
      <input id="email" name="job_application[email]" type="email" required />
    </div>
    <div class="field-wrapper">
      <label for="phone">Phone</label>
      <input id="phone" name="job_application[phone]" type="tel" />
    </div>
    <div class="field-wrapper">
      <label for="job_application_custom_questions_101">How did you hear about us?</label>
      <select id="job_application_custom_questions_101" name="job_application[custom_questions][101]">
        <option value="">Please select</option>
        <option value="linkedin">LinkedIn</option>
        <option value="friend">Friend</option>
        <option value="other">Other</option>
      </select>
    </div>
    <div class="field-wrapper">
      <div class="label">Are you legally authorized to work in the United States?<span class="required">*</span></div>
      <label for="job_application_custom_questions_102_yes">
        <input type="radio" id="job_application_custom_questions_102_yes"
               name="job_application[custom_questions][102]" value="yes" required /> Yes
      </label>
      <label for="job_application_custom_questions_102_no">
        <input type="radio" id="job_application_custom_questions_102_no"
               name="job_application[custom_questions][102]" value="no" required /> No
      </label>
    </div>
    <fieldset>
      <legend>Which benefits interest you?</legend>
      <label>
        <input type="checkbox" name="job_application[custom_questions][103]" value="health" /> Health
      </label>
      <label>
        <input type="checkbox" name="job_application[custom_questions][103]" value="dental" /> Dental
      </label>
      <label>
        <input type="checkbox" name="job_application[custom_questions][103]" value="401k" /> 401k
      </label>
    </fieldset>
    <div class="field-wrapper">
      <label for="cover_letter">Cover Letter</label>
      <textarea id="cover_letter" name="job_application[cover_letter]"></textarea>
    </div>
    <div class="field-wrapper">
      <label for="resume">Resume/CV</label>
      <input id="resume" name="job_application[resume]" type="file" />
    </div>
    <button type="submit">Submit Application</button>
  </form>
  <footer><a href="https://www.greenhouse.io">Powered by Greenhouse</a></footer>
</body>
</html>`;

const NO_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>TestCo Careers</title></head>
<body>
  <h1>Company info</h1>
  <p>This position is no longer open.</p>
  <a href="https://www.greenhouse.com">Powered by Greenhouse</a>
</body>
</html>`;

const GENERIC_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Subscribe to our newsletter</title></head>
<body>
  <h1>Newsletter</h1>
  <form id="newsletter" method="post" action="/submit-application">
    <label for="subscriber_email">Email</label>
    <input id="subscriber_email" name="email" type="email" required />
    <button type="submit">Subscribe</button>
  </form>
</body>
</html>`;

// Lever-shaped markup served from a Greenhouse URL: the adapter must not
// claim another ATS platform's application form as its own.
const FOREIGN_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Submit your application</title></head>
<body>
  <form id="application-form" method="post" action="/submit-application">
    <div class="section page-centered application-form">
      <h4>Submit your application</h4>
      <ul>
        <li class="application-question">
          <label>
            <div class="application-label">Full name<span class="required">&#10033;</span></div>
            <div class="application-field"><input type="text" name="name" required /></div>
          </label>
        </li>
        <li class="application-question">
          <label>
            <div class="application-label">Email<span class="required">&#10033;</span></div>
            <div class="application-field"><input name="email" type="email" required /></div>
          </label>
        </li>
      </ul>
    </div>
  </form>
</body>
</html>`;

/**
 * A Greenhouse application form behind a Google reCAPTCHA challenge
 * (negative-test page: the CAPTCHA must be detected and reported, never
 * solved or bypassed). Mirrors the real embed markup: a div.g-recaptcha
 * widget plus the hidden response field Google's script fills in.
 */
/**
 * MFA / security challenge block (Phase 15A negative fixture): a real
 * challenge page stops the submission; it is NEVER solved or bypassed.
 */
const SECURITY_CHALLENGE_BLOCK = `
<div class="application--security-challenge" data-mfa-challenge>
  <h2>Security check</h2>
  <p>Enter the verification code we sent to your device to continue.</p>
  <label for="verification_code">Verification code</label>
  <input id="verification_code" name="verification_code" autocomplete="one-time-code" type="text" />
</div>`;

/** The modern application form behind an MFA / security challenge. */
const SECURITY_CHALLENGE_PAGE_HTML = MODERN_PAGE_HTML.replace(
  '</form>',
  `</form>${SECURITY_CHALLENGE_BLOCK}`
);

/** The modern application form whose submission endpoint always errors. */
const SUBMIT_FAIL_PAGE_HTML = MODERN_PAGE_HTML.replace(
  'action="/submit-application"',
  'action="/submit-application-error"'
);

/**
 * Custom-domain board pattern: a wrapper page with NO form of its own that
 * hosts the application form in a same-origin Greenhouse-style embed frame.
 */
const EMBEDDED_WRAPPER_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>TestCo Careers - Apply</title></head>
<body>
  <h1>Apply for this job</h1>
  <div id="grnhse_container"><div id="grnhse_app">
    <iframe id="grnhse_iframe" title="Greenhouse Job Board" width="100%" src="/embed/job_app"></iframe>
  </div></div>
</body>
</html>`;

/**
 * SSRF regression fixture: the form lives in a data: iframe. The frame
 * layer must NEVER enter non-http(s) frames, so this page must be reported
 * as "no application form" - nothing may be read, filled, or submitted
 * inside that frame.
 */
const EMBEDDED_DATA_WRAPPER_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>TestCo Careers - Apply</title></head>
<body>
  <h1>Apply for this job</h1>
  <iframe id="untrusted_frame" title="Untrusted" width="100%"
    src="data:text/html,%3Cform%20id%3D%27application-form%27%20class%3D%27application--form%27%3E%3Cinput%20id%3D%27first_name%27%20aria-required%3D%27true%27%20/%3E%3C/form%3E"></iframe>
</body>
</html>`;

/**
 * A CAPTCHA that loads ASYNCHRONOUSLY after the form's first scan - the
 * pre-submit challenge gate must still stop the submission before the
 * final submit action (detection only; never solved or bypassed).
 */
const CAPTCHA_LATE_PAGE_HTML = MODERN_PAGE_HTML.replace(
  '</body>',
  `<script>
  setTimeout(function () {
    var box = document.createElement('div');
    box.className = 'g-recaptcha';
    box.setAttribute('data-sitekey', 'test-site-key');
    document.body.appendChild(box);
  }, 1500);
</script>
</body>`
);

const CAPTCHA_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Job Application for Site Reliability Engineer at TestCo</title></head>
<body>
<div id="react-portal-mount-point"></div>
<main class="main job-post">
  <h1>Site Reliability Engineer</h1>
  <form id="application-form" class="application--form" method="post" action="/submit-application">
    <div class="application--questions">
      <div class="field-wrapper"><div class="text-input-wrapper">
        <label id="first_name-label" for="first_name" class="label">First Name*</label>
        <input id="first_name" class="input input__single-line" aria-label="First Name"
               aria-required="true" type="text" autoComplete="given-name" />
      </div></div>
      <div class="field-wrapper"><div class="text-input-wrapper">
        <label id="email-label" for="email" class="label">Email*</label>
        <input id="email" class="input input__single-line" aria-label="Email"
               aria-required="true" type="text" autoComplete="email" />
      </div></div>
      <div class="field-wrapper">
        <div role="group" aria-labelledby="upload-label-resume" aria-required="true" class="file-upload">
          <div id="upload-label-resume" class="label upload-label">Resume/CV*</div>
          <div class="file-upload__wrapper">
            <label class="visually-hidden" for="resume">Attach</label>
            <input id="resume" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" />
          </div>
        </div>
      </div>
    </div>
    <div class="application--captcha">
      <div class="g-recaptcha" data-sitekey="test-site-key"></div>
      <textarea id="g-recaptcha-response" name="g-recaptcha-response" class="g-recaptcha-response"
                style="display:none" aria-hidden="true"></textarea>
    </div>
    <div class="application--submit">
      <button type="submit" class="btn btn--pill">Submit application</button>
    </div>
  </form>
</main>
<footer class="footer">
  <a class="footer-logo-link" target="_blank" href="https://www.greenhouse.com">Powered by Greenhouse</a>
</footer>
</body>
</html>`;

// A form whose action points at a mock ATS that answers 2xx WITHOUT the
// documented confirmation body (Phase 15B.2 scenario: HTTP 2xx without
// sufficient success evidence must never be claimed as SUBMITTED).
const SUBMIT_NO_CONFIRMATION_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Job Application for Test Engineer at TestCo</title></head>
<body>
  <h1>Test Engineer</h1>
  <form id="application-form" class="application--form" method="post" action="/submit-application-no-confirmation">
    <div class="field-wrapper"><div class="text-input-wrapper">
      <label id="first_name-label" for="first_name" class="label">First Name*</label>
      <input id="first_name" class="input input__single-line" aria-label="First Name"
             aria-required="true" type="text" />
    </div></div>
    <div class="application--submit">
      <button type="submit" class="btn btn--pill">Submit application</button>
    </div>
  </form>
</body>
</html>`;

export async function startMockGreenhouseServer(): Promise<MockGreenhouseServer> {
  const submissions: Record<string, unknown>[] = [];
  const requests: { method: string; path: string }[] = [];
  let confirmationSeq = 0;

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    requests.push({ method: req.method ?? 'GET', path: url });
    const html = (body: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };

    // Controlled failure: kill the connection before any response is written
    // (Phase 14 worker-failure/retry tests - a crashed upstream, never a
    // submission endpoint).
    if (url === '/broken') {
      req.socket.destroy();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };

        // Phase 15A: the mock ATS submission endpoint. Accepts ONLY the
        // identifiers-only MOCK_SUBMISSION envelope and answers with a
        // verifiable confirmation. No candidate data is ever expected here.
        if (url === '/submit-application') {
          let accepted = false;
          let confirmationId: string | null = null;
          try {
            const envelope = JSON.parse(body) as {
              kind?: string;
              applicationId?: string;
              submissionAttemptId?: string;
            };
            accepted =
              envelope?.kind === 'MOCK_SUBMISSION' &&
              typeof envelope.applicationId === 'string' &&
              envelope.applicationId.length > 0 &&
              typeof envelope.submissionAttemptId === 'string' &&
              envelope.submissionAttemptId.length > 0;
          } catch {
            accepted = false;
          }
          if (accepted) {
            confirmationSeq += 1;
            confirmationId = `mock-gh-app-${confirmationSeq}`;
            submissions.push({ path: url, body, accepted: true, confirmationId });
            json(200, {
              ok: true,
              confirmationId,
              applicationId: confirmationId,
              submittedAt: new Date().toISOString(),
            });
          } else {
            submissions.push({ path: url, body, accepted: false });
            json(400, { ok: false, error: 'invalid mock submission envelope' });
          }
          return;
        }

        // Phase 15A: a mock ATS that refuses every submission (HTTP 500).
        if (url === '/submit-application-error') {
          submissions.push({ path: url, body, accepted: false, reason: 'mock-ats-error' });
          json(500, { ok: false, error: 'mock ATS submission failure' });
          return;
        }

        // Phase 15B.2: a mock ATS that answers 2xx WITHOUT any verifiable
        // confirmation body. A bare 2xx is NOT sufficient success evidence
        // for this mock contract - the outcome must be UNKNOWN.
        if (url === '/submit-application-no-confirmation') {
          submissions.push({ path: url, body, accepted: false, reason: 'no-confirmation' });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body>thanks</body></html>');
          return;
        }

        // Any other POST is recorded as a submission attempt so tests can
        // prove that nothing is ever submitted.
        submissions.push({ path: url, body, accepted: false });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>submitted</body></html>');
      });
      return;
    }

    if (req.method === 'GET') {
      if (url === '/' || url === '') return html(MODERN_PAGE_HTML);
      if (url === '/embed/job_app') return html(MODERN_PAGE_HTML);
      // Job-board shaped pages (`/{board_token}/jobs/{id}`): the documented
      // URL shape the Job Board API path parses. Same modern form markup.
      if (/^\/[^/]+\/jobs\/\d+$/.test(url)) return html(MODERN_PAGE_HTML);
      if (url === '/submit-no-confirmation') return html(SUBMIT_NO_CONFIRMATION_PAGE_HTML);
      if (url === '/embedded') return html(EMBEDDED_WRAPPER_HTML);
      if (url === '/embedded-data') return html(EMBEDDED_DATA_WRAPPER_HTML);
      if (url === '/captcha-late') return html(CAPTCHA_LATE_PAGE_HTML);
      if (url === '/classic') return html(CLASSIC_PAGE_HTML);
      if (url === '/no-form') return html(NO_FORM_HTML);
      if (url === '/generic-form') return html(GENERIC_FORM_HTML);
      if (url === '/foreign') return html(FOREIGN_FORM_HTML);
      if (url === '/captcha') return html(CAPTCHA_PAGE_HTML);
      if (url === '/submit-fail') return html(SUBMIT_FAIL_PAGE_HTML);
      if (url === '/security-challenge') return html(SECURITY_CHALLENGE_PAGE_HTML);
    }

    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Not Found</title></head><body><h1>404</h1></body></html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    submissions,
    requests,
    close(): Promise<void> {
      // Force-close lingering keep-alive sockets so shutdown never hangs.
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
