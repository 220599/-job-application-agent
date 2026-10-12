import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

import { launchBrowser, closeBrowser, UrlBlockedError, type JaaPage } from '../src';

/**
 * Phase 15B.1 - narrow, SSRF-safe iframe interaction tests.
 *
 * The frame layer must:
 *  - only ever enter child frames whose URL passes the SAME SSRF policy as
 *    navigation (non-http(s) frames such as data: are never entered);
 *  - be same-origin by DEFAULT - a cross-origin frame is entered only with
 *    an explicit origin / provider-host-suffix allowlist;
 *  - never offer frame navigation;
 *  - re-validate URL + origin on EVERY interaction (a frame that later
 *    navigates to a disallowed origin refuses interaction).
 *
 * All fixtures are local mock servers on 127.0.0.1 (test-only
 * allowPrivateUrls browser); the two servers have DIFFERENT origins (ports)
 * so cross-origin policy is exercised for real.
 */

interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const CHILD_FORM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Child Form</title></head>
<body>
  <h1>child form</h1>
  <form id="child-form">
    <label for="answer">Answer</label>
    <input id="answer" type="text" />
    <button id="ping" type="button">Ping</button>
  </form>
</body>
</html>`;

/**
 * The data: frame carries a form - a negative fixture: the frame layer must
 * never enter non-http(s) frames, so the form must stay invisible.
 */
const DATA_WRAPPER_HTML = `<!DOCTYPE html><html><body><h1>wrapper</h1>
  <iframe id="child" src="data:text/html,%3Cform%20id%3D%27child-form%27%3E%3Cinput%20id%3D%27answer%27%20/%3E%3C/form%3E"></iframe>
</body></html>`;

function startServer(childHtml: string): Promise<FixtureServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      const html = (body: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(body);
      };
      if (url === '/child-form') return html(childHtml);
      if (url === '/same-wrapper') {
        return html(`<!DOCTYPE html><html><body><h1>wrapper</h1>
          <iframe id="child" src="/child-form"></iframe></body></html>`);
      }
      if (url === '/cross-wrapper') {
        // The other server's origin (different port) - cross-origin child.
        return html(`<!DOCTYPE html><html><body><h1>wrapper</h1>
          <iframe id="child" src="${crossWrapperTarget}/child-form"></iframe></body></html>`);
      }
      if (url === '/data-wrapper') return html(DATA_WRAPPER_HTML);
      if (url === '/plain') {
        return html('<!DOCTYPE html><html><body><h1>no frames here</h1></body></html>');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise((done, reject) => {
            server.closeAllConnections?.();
            server.close((err) => (err ? reject(err) : done()));
          }),
      });
    });
  });
}

let serverA: FixtureServer;
let serverB: FixtureServer;
/** Set once both servers exist; the /cross-wrapper route targets B. */
let crossWrapperTarget = '';

beforeAll(async () => {
  serverA = await startServer(CHILD_FORM_HTML);
  serverB = await startServer(CHILD_FORM_HTML);
  crossWrapperTarget = serverB.url;
});

afterAll(async () => {
  await closeBrowser();
  await serverA.close();
  await serverB.close();
});

async function withPage<T>(fn: (page: JaaPage) => Promise<T>): Promise<T> {
  const browser = await launchBrowser({ allowPrivateUrls: true });
  const context = await browser.createContext({ allowPrivateUrls: true });
  const page = await context.createPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

describe('frameContaining (narrow SSRF-safe iframe lookup)', () => {
  it('finds and interacts with a same-origin child frame', async () => {
    await withPage(async (page) => {
      await page.navigate(`${serverA.url}/same-wrapper`);
      const frame = await page.frameContaining('form', { timeoutMs: 5_000 });
      expect(frame).not.toBeNull();
      expect(frame!.url()).toContain('/child-form');

      // In-frame evaluate runs inside the frame document.
      const title = await frame!.evaluate('document.title');
      expect(title).toBe('Child Form');

      // In-frame interaction works through the same abstraction.
      await frame!.click('#answer');
      await frame!.waitForSelector('#child-form');
      await frame!.evaluate(
        `(function () { document.getElementById('answer').value = 'filled'; })()`
      );
      const value = await frame!.evaluate('document.getElementById("answer").value');
      expect(value).toBe('filled');
    });
  });

  it('returns null when no child frame contains the selector', async () => {
    await withPage(async (page) => {
      await page.navigate(`${serverA.url}/plain`);
      const frame = await page.frameContaining('form', { timeoutMs: 1_000 });
      expect(frame).toBeNull();
    });
  });

  it('never enters a non-http(s) (data:) frame', async () => {
    await withPage(async (page) => {
      // The form exists INSIDE the data: frame - it must still be invisible:
      // non-http(s) frames never pass the SSRF policy and are never entered.
      await page.navigate(`${serverA.url}/data-wrapper`);
      const frame = await page.frameContaining('form', { timeoutMs: 1_500 });
      expect(frame).toBeNull();
    });
  });

  it('refuses a cross-origin frame by default (same-origin only)', async () => {
    await withPage(async (page) => {
      await page.navigate(`${serverA.url}/cross-wrapper`);
      const frame = await page.frameContaining('form', { timeoutMs: 1_500 });
      expect(frame).toBeNull();
    });
  });

  it('enters a cross-origin frame only with an explicit origin allowlist', async () => {
    await withPage(async (page) => {
      await page.navigate(`${serverA.url}/cross-wrapper`);
      const frame = await page.frameContaining('form', {
        allowedOrigins: [serverB.url],
        timeoutMs: 5_000,
      });
      expect(frame).not.toBeNull();
      expect(frame!.url()).toContain('/child-form');
      const title = await frame!.evaluate('document.title');
      expect(title).toBe('Child Form');
    });
  });

  it('matches allowed host suffixes only at label boundaries', async () => {
    await withPage(async (page) => {
      await page.navigate(`${serverA.url}/cross-wrapper`);

      // '27.0.0.1' must NOT match host '127.0.0.1': the suffix has to
      // align on a label boundary (like 'greenhouse.io' matching
      // 'job-boards.greenhouse.io', never 'notgreenhouse.io').
      const blocked = await page.frameContaining('form', {
        allowedOriginSuffixes: ['27.0.0.1'],
        timeoutMs: 1_500,
      });
      expect(blocked).toBeNull();

      // The full host as a suffix matches.
      const allowed = await page.frameContaining('form', {
        allowedOriginSuffixes: ['127.0.0.1'],
        timeoutMs: 5_000,
      });
      expect(allowed).not.toBeNull();
    });
  });

  it('refuses every interaction once the frame navigates to a disallowed origin', async () => {
    await withPage(async (page) => {
      await page.navigate(`${serverA.url}/same-wrapper`);
      const frame = await page.frameContaining('form', { timeoutMs: 5_000 });
      expect(frame).not.toBeNull();

      // The frame navigates ITSELF to the other origin (frame-level
      // navigation the page chose - this layer never offers it). From that
      // moment the handle must refuse interaction: URL + origin are
      // re-validated on EVERY call.
      await frame!.evaluate(
        `(function () { window.location.href = ${JSON.stringify(
          `${serverB.url}/child-form`
        )}; })()`
      );
      const deadline = Date.now() + 5_000;
      while (!frame!.url().includes(`:${serverB.port}`) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(frame!.url()).toContain(`:${serverB.port}`);

      await expect(frame!.evaluate('document.title')).rejects.toBeInstanceOf(UrlBlockedError);
      await expect(frame!.click('#answer')).rejects.toBeInstanceOf(UrlBlockedError);
    });
  });
});
