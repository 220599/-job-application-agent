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
 * a submission so tests can prove that nothing is ever submitted.
 */

export interface MockGreenhouseServer {
  url: string;
  submissions: Record<string, unknown>[];
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
            var item = document.createElement('div');
            item.setAttribute('role', 'option');
            item.textContent = opts[j];
            list.appendChild(item);
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

export async function startMockGreenhouseServer(): Promise<MockGreenhouseServer> {
  const submissions: Record<string, unknown>[] = [];

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const html = (body: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        submissions.push({ path: url, body });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>submitted</body></html>');
      });
      return;
    }

    if (req.method === 'GET') {
      if (url === '/' || url === '') return html(MODERN_PAGE_HTML);
      if (url === '/classic') return html(CLASSIC_PAGE_HTML);
      if (url === '/no-form') return html(NO_FORM_HTML);
      if (url === '/generic-form') return html(GENERIC_FORM_HTML);
      if (url === '/foreign') return html(FOREIGN_FORM_HTML);
    }

    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Not Found</title></head><body><h1>404</h1></body></html>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    submissions,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
