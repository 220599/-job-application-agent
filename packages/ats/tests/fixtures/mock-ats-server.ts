import http from 'http';
import type { AddressInfo } from 'net';

/**
 * Local mock ATS server for @jaa/ats tests.
 *
 * Same page shape as the Phase 6 mock ATS (form with name/email/phone,
 * resume upload, submit button, #status element), plus a required-field
 * marker and a SELECT with options so field/option detection can be
 * verified deterministically. Runs on an ephemeral 127.0.0.1 port.
 */

export interface MockAtsServer {
  url: string;
  submissions: { name: string; email: string; phone: string; resumeFileName: string | null; role: string }[];
  close(): Promise<void>;
}

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Mock ATS - Job Application</title>
  <style>body { font-family: sans-serif; max-width: 480px; margin: 40px auto; }
  label { display: block; margin-top: 12px; font-weight: bold; }
  input, select, textarea { width: 100%; padding: 6px; margin-top: 4px; }
  button { margin-top: 16px; padding: 8px 20px; }
  #status { margin-top: 16px; font-weight: bold; }</style>
</head>
<body>
  <h1>Mock ATS - Job Application</h1>
  <form id="app-form">
    <label for="name">Full Name</label>
    <input id="name" name="name" type="text" required />
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required />
    <label for="phone">Phone</label>
    <input id="phone" name="phone" type="tel" />
    <label for="role">Role</label>
    <select id="role" name="role" required>
      <option value="">Select a role...</option>
      <option value="engineer">Engineer</option>
      <option value="analyst">Analyst</option>
    </select>
    <label for="resume">Resume</label>
    <input id="resume" name="resume" type="file" required />
    <button type="submit" id="submit-btn">Submit Application</button>
  </form>
  <div id="status" role="status"></div>
  <script>
    document.getElementById('app-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: document.getElementById('name').value,
        email: document.getElementById('email').value,
        phone: document.getElementById('phone').value,
        role: document.getElementById('role').value,
        resumeFileName: document.getElementById('resume').files.length > 0
          ? document.getElementById('resume').files[0].name : null,
      };
      try {
        const res = await fetch('/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        document.getElementById('status').textContent =
          data.status === 'ok' ? 'Application submitted successfully' : 'Submission failed';
      } catch (err) {
        document.getElementById('status').textContent = 'Submission failed';
      }
    });
  </script>
</body>
</html>`;

export async function startMockAtsServer(): Promise<MockAtsServer> {
  const submissions: MockAtsServer['submissions'] = [];

  const server = http.createServer((req, res) => {
    // A 200 page that is NOT an application form (for PAGE_NOT_RECOGNIZED).
    if (req.method === 'GET' && req.url === '/no-form') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>Mock ATS - Info Page</title></head><body><h1>Company info</h1><p>No form here.</p></body></html>'
      );
      return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    if (req.method === 'POST' && req.url === '/submit') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          submissions.push({
            name: String(parsed.name ?? ''),
            email: String(parsed.email ?? ''),
            phone: String(parsed.phone ?? ''),
            resumeFileName: parsed.resumeFileName ?? null,
            role: String(parsed.role ?? ''),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error' }));
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Mock ATS - Not Found</title></head><body><h1>404</h1></body></html>');
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
