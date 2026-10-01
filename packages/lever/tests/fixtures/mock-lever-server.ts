import http from 'http';
import type { AddressInfo } from 'net';

/**
 * Local mock Lever server for @jaa/lever tests.
 *
 * Deterministic fixture page modeled on Lever's real application markup
 * (form#application-form, div.section > h4, li.application-question,
 * div.application-label/label text + span.required "✱",
 * div.application-field(.required-field), ul[data-qa="multiple-choice"|
 * "checkboxes"] of label > input + span.application-answer-alternative,
 * cards[<uuid>][fieldN] names, hidden baseTemplate/account inputs,
 * hCaptcha placeholder). Runs on an ephemeral 127.0.0.1 port; never
 * touches the network. Any form POST is recorded as a submission so
 * tests can prove that nothing is ever submitted.
 */

export interface MockLeverServer {
  url: string;
  submissions: Record<string, unknown>[];
  close(): Promise<void>;
}

const APPLY_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Administrative Business Partner - TestCo | Lever</title></head>
<body>
<div class="posting-page">
  <div class="posting-headline">
    <h2>Administrative Business Partner</h2>
    <div class="posting-categories"><span>London, United Kingdom</span></div>
  </div>
  <form id="application-form" enctype="multipart/form-data" method="POST" action="/submit-application">
    <div class="section page-centered application-form">
      <h4>Submit your application</h4>
      <ul>
        <li class="application-question resume">
          <label>
            <div class="application-label">Resume/CV <span class="required">&#10033;</span></div>
            <div class="application-field">
              <a href="#" class="postings-btn template-btn-utility visible-resume-upload">
                <span class="filename"></span>
                <span class="default-label">ATTACH RESUME/CV</span>
                <input class="application-file-input invisible-resume-upload" data-qa="input-resume"
                       id="resume-upload-input" name="resume" tabindex="-1" type="file">
              </a>
            </div>
          </label>
        </li>
        <li class="application-question">
          <label>
            <div class="application-label">Full name<span class="required">&#10033;</span></div>
            <div class="application-field">
              <input type="text" data-qa="name-input" name="name" required>
            </div>
          </label>
        </li>
        <li class="application-question">
          <label>
            <div class="application-label">Email<span class="required">&#10033;</span></div>
            <div class="application-field">
              <input name="email" data-qa="email-input" type="email" required>
            </div>
          </label>
        </li>
        <li class="application-question">
          <label>
            <div class="application-label">Phone </div>
            <div class="application-field">
              <input type="text" data-qa="phone-input" name="phone">
            </div>
          </label>
        </li>
        <li class="application-question" data-qa="structured-contact-location-question">
          <label>
            <div class="application-label">Current location <span class="required">&#10033;</span></div>
            <div class="application-field">
              <input class="location-input" data-qa="location-input" id="location-input" type="text"
                     maxlength="100" name="location" required>
              <input id="selected-location" type="hidden" name="selectedLocation">
            </div>
          </label>
        </li>
        <li class="application-question">
          <label>
            <div class="application-label">Current company </div>
            <div class="application-field">
              <input type="text" data-qa="org-input" name="org">
            </div>
          </label>
        </li>
      </ul>
    </div>
    <div class="section page-centered application-form">
      <h4>Links</h4>
      <ul>
        <li class="application-question">
          <label>
            <div class="application-label">LinkedIn URL</div>
            <div class="application-field">
              <input type="text" name="urls[LinkedIn]">
            </div>
          </label>
        </li>
        <li class="application-question">
          <label>
            <div class="application-label">GitHub URL</div>
            <div class="application-field">
              <input type="text" name="urls[GitHub]">
            </div>
          </label>
        </li>
        <li class="application-question">
          <label>
            <div class="application-label">Portfolio URL</div>
            <div class="application-field">
              <input type="text" name="urls[Portfolio]">
            </div>
          </label>
        </li>
      </ul>
    </div>
    <div class="section page-centered application-form" data-qa="additional-cards">
      <h4 data-qa="card-name">Supplementary Questions</h4>
      <input type="hidden" value="{}" name="cards[69a985a0-0000-0000-0000-000000000001][baseTemplate]">
      <ul>
        <li class="application-question custom-question">
          <div>
            <div class="application-label full-width multiple-select">
              <div class="text">Language Skill(s) (Check all that apply)<span class="required">&#10033;</span></div>
            </div>
            <div class="application-field full-width required-field">
              <ul data-qa="checkboxes">
                <li>
                  <label>
                    <input type="checkbox" name="cards[69a985a0-0000-0000-0000-000000000001][field0]"
                           value="English (ENG)" required />
                    <span class="application-answer-alternative">English (ENG)</span>
                  </label>
                </li>
                <li>
                  <label>
                    <input type="checkbox" name="cards[69a985a0-0000-0000-0000-000000000001][field0]"
                           value="Spanish (SPA)" required />
                    <span class="application-answer-alternative">Spanish (SPA)</span>
                  </label>
                </li>
                <li>
                  <label>
                    <input type="checkbox" name="cards[69a985a0-0000-0000-0000-000000000001][field0]"
                           value="French (FRA)" required />
                    <span class="application-answer-alternative">French (FRA)</span>
                  </label>
                </li>
              </ul>
            </div>
          </div>
        </li>
        <li class="application-question custom-question">
          <div>
            <div class="application-label full-width text">
              <div class="text">Preferred Name | What would you like us to call you?</div>
            </div>
            <div class="application-field full-width">
              <input class="card-field-input" type="text" placeholder="Type your response" value=""
                     name="cards[69a985a0-0000-0000-0000-000000000001][field1]" />
            </div>
          </div>
        </li>
      </ul>
    </div>
    <div class="section page-centered application-form" data-qa="additional-cards">
      <h4 data-qa="card-name">Work Authorization</h4>
      <input type="hidden" value="{}" name="cards[1c719ca9-0000-0000-0000-000000000002][baseTemplate]">
      <ul>
        <li class="application-question custom-question">
          <div>
            <div class="application-label full-width multiple-choice">
              <div class="text">Are you legally authorized to work in the country for which you are applying?<span class="required">&#10033;</span></div>
            </div>
            <div class="application-field full-width required-field">
              <ul data-qa="multiple-choice">
                <li>
                  <label>
                    <input type="radio" name="cards[1c719ca9-0000-0000-0000-000000000002][field0]"
                           value="Yes" required="required" />
                    <span class="application-answer-alternative">Yes</span>
                  </label>
                </li>
                <li>
                  <label>
                    <input type="radio" name="cards[1c719ca9-0000-0000-0000-000000000002][field0]"
                           value="No" required="required" />
                    <span class="application-answer-alternative">No</span>
                  </label>
                </li>
              </ul>
            </div>
          </div>
        </li>
        <li class="application-question custom-question">
          <div>
            <div class="application-label full-width multiple-choice">
              <div class="text">Will you now or in the future require sponsorship for employment visa status (e.g., H-1B, etc.)?<span class="required">&#10033;</span></div>
            </div>
            <div class="application-field full-width required-field">
              <ul data-qa="multiple-choice">
                <li>
                  <label>
                    <input type="radio" name="cards[1c719ca9-0000-0000-0000-000000000002][field1]"
                           value="Yes" required="required" />
                    <span class="application-answer-alternative">Yes</span>
                  </label>
                </li>
                <li>
                  <label>
                    <input type="radio" name="cards[1c719ca9-0000-0000-0000-000000000002][field1]"
                           value="No" required="required" />
                    <span class="application-answer-alternative">No</span>
                  </label>
                </li>
              </ul>
            </div>
          </div>
        </li>
      </ul>
    </div>
    <div class="section page-centered application-form" data-qa="additional-cards">
      <h4 data-qa="card-name">University</h4>
      <input type="hidden" value="{}" name="cards[3da58b41-0000-0000-0000-000000000003][baseTemplate]">
      <ul>
        <li class="application-question custom-question">
          <div>
            <div class="application-label full-width dropdown">
              <div class="text">Which university are you currently attending or did you last attend?<span class="required">&#10033;</span></div>
            </div>
            <div class="application-field full-width required-field">
              <div class="application-dropdown">
                <select name="cards[3da58b41-0000-0000-0000-000000000003][field0]" required>
                  <option value="">Select...</option>
                  <option value="Aalborg University">Aalborg University</option>
                  <option value="Aalto University">Aalto University</option>
                  <option value="Other (School Not Listed)">Other (School Not Listed)</option>
                </select>
              </div>
            </div>
          </div>
        </li>
      </ul>
    </div>
    <div class="section page-centered application-form" data-qa="additional-cards">
      <h4 data-qa="card-name">Additional Questions</h4>
      <input type="hidden" value="{}" name="cards[ce72d538-0000-0000-0000-000000000004][baseTemplate]">
      <ul>
        <li class="application-question custom-question">
          <div>
            <div class="application-label full-width textarea">
              <div class="text">What has been your favorite project or proudest accomplishment? Why?</div>
            </div>
            <div class="application-field full-width">
              <textarea class="card-field-input" name="cards[ce72d538-0000-0000-0000-000000000004][field0]"></textarea>
            </div>
          </div>
        </li>
      </ul>
    </div>
    <div class="section page-centered application-form">
      <label for="additional-information">
        <h4>Additional information</h4>
      </label>
      <div class="application-additional">
        <textarea placeholder="Add a cover letter or anything else you want to share."
                  name="comments" id="additional-information"></textarea>
      </div>
    </div>
    <input type="hidden" name="accountId" value="test-account-id">
    <input type="hidden" name="linkedInData">
    <input type="hidden" name="origin">
    <input type="hidden" name="referer">
    <input type="hidden" name="timezone" id="applicant-timezone" value="">
    <input type="hidden" name="socialReferralKey">
    <input type="hidden" name="socialSource">
    <input type="hidden" name="resumeStorageId" value="">
    <input id="hcaptchaResponseInput" type="hidden" name="h-captcha-response" value="">
    <div class="section page-centered application-form">
      <ul>
        <li class="application-question">
          <div class="application-field full-width">
            <div data-qa="legitimate-interest-copy">
              TestCo will process your personal data to consider you for employment.
            </div>
            <ul>
              <li>
                <label>
                  <span class="">
                    <div>TestCo Technologies has my consent to contact me about future job opportunities.</div>
                  </span>
                  <input type="hidden" name="consent[marketing]" value="0">
                  <input type="checkbox" name="consent[marketing]" value="1">
                </label>
              </li>
            </ul>
          </div>
        </li>
      </ul>
    </div>
    <div id="h-captcha" class="h-captcha" data-sitekey="test-site-key"></div>
    <div class="section page-centered application-form last-section-apply">
      <button id="btn-submit" type="button" class="postings-btn template-btn-submit black"
              data-qa="btn-submit" href="#">Submit application</button>
    </div>
  </form>
</div>
</body>
</html>`;

const NO_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Careers at TestCo</title></head>
<body>
  <div class="posting-page">
    <h2>This role has been filled</h2>
    <p>Check back later for new openings.</p>
  </div>
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

// Greenhouse-shaped markup served from a Lever URL: the adapter must not
// claim another ATS platform's application form as its own.
const FOREIGN_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Job Application for Analytics Engineer at TestCo</title></head>
<body>
  <div id="react-portal-mount-point"></div>
  <form id="application-form" class="application--form" method="post" action="/submit-application">
    <div class="application--questions">
      <div class="field-wrapper">
        <label id="first_name-label" for="first_name" class="label">First Name*</label>
        <input id="first_name" class="input input__single-line" aria-label="First Name"
               aria-required="true" type="text" />
      </div>
      <div class="field-wrapper">
        <label id="email-label" for="email" class="label">Email*</label>
        <input id="email" class="input input__single-line" aria-label="Email"
               aria-required="true" type="text" autoComplete="email" />
      </div>
    </div>
  </form>
</body>
</html>`;

export async function startMockLeverServer(): Promise<MockLeverServer> {
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
      if (url === '/' || url === '') return html(APPLY_PAGE_HTML);
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
