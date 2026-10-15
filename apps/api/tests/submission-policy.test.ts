import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Load DATABASE_URL before @jaa/database instantiates Prisma (repo convention).
import dotenv from 'dotenv';
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
});

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/jaa_dev';

const {
  REAL_GREENHOUSE_SUBMISSION_FLAG,
  REAL_LEVER_SUBMISSION_FLAG,
  isLoopbackUrl,
  resolveSubmissionMode,
  isRealGreenhouseSubmissionEnabled,
  isRealLeverSubmissionEnabled,
  assertRealGreenhouseSubmissionEnabled,
  assertRealLeverSubmissionEnabled,
  assertAnyRealSubmissionCapabilityEnabled,
  assertRealGreenhouseSubmissionTarget,
  assertRealLeverSubmissionTarget,
  assertMockSubmissionTarget,
  assertSubmissionTarget,
} = await import('@jaa/core');

/**
 * Phase 15B - submission target policy (STEP 11 gates).
 *
 * The policy is decided ONLY by the server from the target URL, and it must
 * fail closed everywhere:
 *
 *  - MOCK  : loopback only + `JAA_ALLOW_MOCK_SUBMISSION=true` opt-in +
 *            never in production (unchanged Phase 15A behavior);
 *  - REAL  : each provider's OWN capability flag must be explicitly on
 *            (`JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED` for Greenhouse,
 *            `JAA_REAL_LEVER_SUBMISSION_ENABLED` for Lever - Phase 15C),
 *            the target must belong to THAT provider, never loopback, and
 *            SSRF public-URL validated. One flag can never enable the
 *            other provider.
 *
 * There is deliberately no "allow any URL" escape hatch.
 */

const FLAG = REAL_GREENHOUSE_SUBMISSION_FLAG;
const LEVER_FLAG = REAL_LEVER_SUBMISSION_FLAG;
const REAL_GREENHOUSE_URL = 'https://job-boards.greenhouse.io/acme/jobs/12345';
const REAL_LEVER_URL = 'https://jobs.lever.co/acme/12345';

const ENV_KEYS = [FLAG, LEVER_FLAG, 'JAA_ALLOW_MOCK_SUBMISSION', 'NODE_ENV'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env[FLAG];
  delete process.env[LEVER_FLAG];
  delete process.env.JAA_ALLOW_MOCK_SUBMISSION;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('submission target policy - mode resolution', () => {
  it('classifies every loopback form as MOCK', () => {
    expect(isLoopbackUrl('http://127.0.0.1:9001/applications/new')).toBe(true);
    expect(isLoopbackUrl('http://localhost:9001/applications/new')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:9001/applications/new')).toBe(true);
    expect(resolveSubmissionMode('http://127.0.0.1:9001/applications/new')).toBe('MOCK');
  });

  it('classifies non-loopback targets as REAL - the URL alone decides', () => {
    expect(isLoopbackUrl(REAL_GREENHOUSE_URL)).toBe(false);
    expect(resolveSubmissionMode(REAL_GREENHOUSE_URL)).toBe('REAL');
    // Even a private (non-loopback) address is "REAL" mode - and is then
    // refused by the SSRF policy below. Mode detection never opens a hole.
    expect(resolveSubmissionMode('https://10.0.0.5/jobs/1')).toBe('REAL');
  });
});

describe('submission target policy - capability fails closed', () => {
  it('real submission is disabled by default', () => {
    expect(isRealGreenhouseSubmissionEnabled()).toBe(false);
    expect(() => assertRealGreenhouseSubmissionEnabled()).toThrowError(
      /JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED/
    );
  });

  it('a real Greenhouse target is refused while the capability is off', () => {
    expect(() => assertSubmissionTarget(REAL_GREENHOUSE_URL, 'GREENHOUSE')).toThrowError(
      /disabled/i
    );
    // Only exactly "true" enables it - anything else stays disabled.
    process.env[FLAG] = 'TRUE';
    expect(isRealGreenhouseSubmissionEnabled()).toBe(false);
    process.env[FLAG] = '1';
    expect(isRealGreenhouseSubmissionEnabled()).toBe(false);
  });

  it('one capability can never enable the OTHER provider (Phase 15C: Lever needs its own flag)', () => {
    // Greenhouse capability on -> Lever is still refused fail-closed.
    process.env[FLAG] = 'true';
    expect(isRealLeverSubmissionEnabled()).toBe(false);
    expect(() => assertSubmissionTarget(REAL_LEVER_URL, 'LEVER')).toThrowError(
      /JAA_REAL_LEVER_SUBMISSION_ENABLED/
    );
    // Lever capability on -> Greenhouse is still refused fail-closed.
    delete process.env[FLAG];
    process.env[LEVER_FLAG] = 'true';
    expect(isRealGreenhouseSubmissionEnabled()).toBe(false);
    expect(() => assertSubmissionTarget(REAL_GREENHOUSE_URL, 'GREENHOUSE')).toThrowError(
      /JAA_REAL_GREENHOUSE_SUBMISSION_ENABLED/
    );
    // An unrecognized provider is refused the same way as before (with
    // the Greenhouse capability on, the provider check is what refuses).
    process.env[FLAG] = 'true';
    delete process.env[LEVER_FLAG];
    expect(() => assertSubmissionTarget(REAL_GREENHOUSE_URL, 'UNKNOWN')).toThrowError(
      /only permitted for Greenhouse/i
    );
  });

  it('an authorized real Lever target is admitted only with the Lever capability on', () => {
    process.env[LEVER_FLAG] = 'true';
    expect(assertSubmissionTarget(REAL_LEVER_URL, 'LEVER')).toBe('REAL');
    // Only exactly "true" enables it - anything else stays disabled.
    process.env[LEVER_FLAG] = 'TRUE';
    expect(isRealLeverSubmissionEnabled()).toBe(false);
  });

  it('the Lever real target policy enforces loopback and SSRF rules exactly like Greenhouse', () => {
    process.env[LEVER_FLAG] = 'true';
    expect(() => assertRealLeverSubmissionTarget('http://127.0.0.1:9001/x', 'LEVER')).toThrowError(
      /loopback/i
    );
    for (const url of [
      'https://10.0.0.5/jobs/1',
      'https://169.254.169.254/latest/meta-data',
      'https://[fd00::1]/jobs/1',
      'ftp://jobs.lever.co/acme/1',
    ]) {
      expect(() => assertRealLeverSubmissionTarget(url, 'LEVER')).toThrowError(
        /url safety policy/i
      );
    }
  });

  it('the early real-capability gate is fail-closed with no flag and open with either one', () => {
    expect(() => assertAnyRealSubmissionCapabilityEnabled()).toThrowError(/disabled/i);
    process.env[FLAG] = 'true';
    expect(() => assertAnyRealSubmissionCapabilityEnabled()).not.toThrow();
    delete process.env[FLAG];
    process.env[LEVER_FLAG] = 'true';
    expect(() => assertAnyRealSubmissionCapabilityEnabled()).not.toThrow();
  });

  it('a real target must never be a loopback mock server', () => {
    process.env[FLAG] = 'true';
    expect(() => assertRealGreenhouseSubmissionTarget('http://127.0.0.1:9001/x', 'GREENHOUSE')).toThrowError(
      /loopback/i
    );
  });

  it('SSRF policy is never relaxed for real targets', () => {
    process.env[FLAG] = 'true';
    const refused = [
      'https://10.0.0.5/jobs/1', // private IPv4
      'https://169.254.169.254/latest/meta-data', // link-local / metadata
      'https://[fd00::1]/jobs/1', // private IPv6 (unique-local)
      'https://internal.corp.local/jobs/1', // internal hostname
      'ftp://job-boards.greenhouse.io/acme/jobs/1', // unsafe protocol
      'https://user:pass@job-boards.greenhouse.io/acme/jobs/1', // credentials in URL
    ];
    for (const url of refused) {
      expect(() => assertRealGreenhouseSubmissionTarget(url, 'GREENHOUSE')).toThrowError(
        /url safety policy/i
      );
      expect(() => assertSubmissionTarget(url, 'GREENHOUSE')).toThrowError(/url safety policy/i);
    }
  });

  it('an authorized real Greenhouse target is admitted only with the capability on', () => {
    process.env[FLAG] = 'true';
    expect(assertSubmissionTarget(REAL_GREENHOUSE_URL, 'GREENHOUSE')).toBe('REAL');
  });
});

describe('submission target policy - mock boundary unchanged (Phase 15A)', () => {
  it('mock submission still requires the explicit opt-in', () => {
    expect(() => assertMockSubmissionTarget('http://127.0.0.1:9001/x')).toThrowError(
      /JAA_ALLOW_MOCK_SUBMISSION/
    );
    process.env.JAA_ALLOW_MOCK_SUBMISSION = 'true';
    expect(assertSubmissionTarget('http://127.0.0.1:9001/x', 'GREENHOUSE')).toBe('MOCK');
  });

  it('mock submission is refused in production no matter what', () => {
    process.env.JAA_ALLOW_MOCK_SUBMISSION = 'true';
    process.env.NODE_ENV = 'production';
    expect(() => assertMockSubmissionTarget('http://127.0.0.1:9001/x')).toThrowError(
      /disabled in production/i
    );
  });

  it('the mock opt-in can never reach a real ATS URL', () => {
    process.env.JAA_ALLOW_MOCK_SUBMISSION = 'true';
    expect(() => assertMockSubmissionTarget(REAL_GREENHOUSE_URL)).toThrowError(
      /loopback mock ATS servers/i
    );
  });
});
