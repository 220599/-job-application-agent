import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Load DATABASE_URL before @jaa/database instantiates Prisma (repo convention).
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const {
  OrchestrationError,
  classifyPreparationError,
  safeErrorMessage,
  safeAutomationRunView,
  PREPARATION_QUEUE_NAME,
  PREPARATION_MAX_ATTEMPTS,
} = await import('@jaa/core');
const { preparationJobPayloadSchema } = await import('@jaa/shared');
const { AtsError } = await import('@jaa/ats');

describe('preparation job payload contract (security)', () => {
  it('accepts identifiers only', () => {
    const parsed = preparationJobPayloadSchema.parse({
      applicationId: 'app_1',
      automationRunId: 'run_1',
    });
    expect(parsed).toEqual({ applicationId: 'app_1', automationRunId: 'run_1' });
  });

  it('rejects any extra keys - resume content, answers, secrets cannot ride in Redis', () => {
    for (const payload of [
      { applicationId: 'a', automationRunId: 'r', resumeText: 'Alice Nguyen, Senior Engineer' },
      { applicationId: 'a', automationRunId: 'r', answers: { question: 'What is your name?' } },
      { applicationId: 'a', automationRunId: 'r', token: 'secret-token' },
      { applicationId: 'a', automationRunId: 'r', candidateFacts: { employer: 'Acme' } },
    ]) {
      expect(preparationJobPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });

  it('rejects missing or empty identifiers', () => {
    expect(preparationJobPayloadSchema.safeParse({ applicationId: 'a' }).success).toBe(false);
    expect(
      preparationJobPayloadSchema.safeParse({ applicationId: '', automationRunId: 'r' }).success
    ).toBe(false);
  });

  it('uses a single stable queue name', () => {
    expect(PREPARATION_QUEUE_NAME).toBe('application-preparation');
  });
});

describe('safe error messages', () => {
  it('redacts URL query strings (tokens never persist)', () => {
    const safe = safeErrorMessage(
      'Navigation failed for https://boards.example.com/apply?token=abc123&session=xyz'
    );
    expect(safe).not.toContain('abc123');
    expect(safe).not.toContain('session=xyz');
    expect(safe).toContain('https://boards.example.com/apply?');
  });

  it('redacts credentials embedded in URLs', () => {
    const safe = safeErrorMessage('Failed to load https://user:pass@host.example/form');
    expect(safe).not.toContain('user:pass');
    expect(safe).toContain('https://***@host.example/form');
  });

  it('redacts key=value secrets in free text and caps length', () => {
    const safe = safeErrorMessage(`boom authorization: Bearer eyJhbGciOi ${'x'.repeat(2000)}`);
    expect(safe).not.toContain('eyJhbGciOi');
    expect(safe.length).toBeLessThanOrEqual(500);
  });

  it('handles non-Error inputs', () => {
    expect(safeErrorMessage('plain string')).toBe('plain string');
    expect(safeErrorMessage({ weird: true })).toContain('object');
  });
});

describe('error classification (deliberate retries)', () => {
  it('never retries deterministic eligibility/state failures', () => {
    for (const err of [
      new OrchestrationError('UNSUPPORTED_ATS', 'no adapter'),
      new OrchestrationError('INVALID_APPLICATION_URL', 'bad url'),
      new OrchestrationError('APPLICATION_NOT_FOUND', 'missing'),
      new OrchestrationError('APPLICATION_TERMINAL', 'submitted'),
      new OrchestrationError('RESUME_NOT_APPROVED', 'not approved'),
      new Error('APPLICATION_NOT_FOUND: app_1'),
      new Error('INVALID_APPLICATION_STATUS: SUBMITTED cannot be prepared'),
      new Error('APPLICATION_URL_MISSING: application has no application URL'),
    ]) {
      const cls = classifyPreparationError(err);
      expect(cls.retryable).toBe(false);
    }
  });

  it('maps deterministic failures to stable codes', () => {
    expect(classifyPreparationError(new Error('APPLICATION_NOT_FOUND: x')).code).toBe(
      'APPLICATION_NOT_FOUND'
    );
    expect(classifyPreparationError(new Error('INVALID_APPLICATION_STATUS: x')).code).toBe(
      'APPLICATION_STATE_NOT_PREPARABLE'
    );
    expect(classifyPreparationError(new AtsError('BLOCKED_BY_SECURITY_POLICY', 'x')).code).toBe(
      'BLOCKED_BY_SECURITY_POLICY'
    );
  });

  it('retries transient network / provider / browser failures', () => {
    const connRefused = new Error('connect ECONNREFUSED 127.0.0.1:9');
    (connRefused as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    for (const err of [
      connRefused,
      new Error('Navigation timeout of 30000 ms exceeded'),
      new Error("Can't reach database server at `localhost:5432`"),
      new AtsError('PROVIDER_UNAVAILABLE', 'greenhouse is down', 'GREENHOUSE'),
    ]) {
      const cls = classifyPreparationError(err);
      expect(cls.retryable).toBe(true);
    }
    expect(classifyPreparationError(connRefused).code).toBe('TRANSIENT_FAILURE');
    expect(classifyPreparationError(new AtsError('PROVIDER_UNAVAILABLE', 'x')).code).toBe(
      'PROVIDER_UNAVAILABLE'
    );
  });

  it('retries INSPECTION_FAILED only when the underlying cause is transient', () => {
    const transient = new AtsError(
      'INSPECTION_FAILED',
      'inspection blew up',
      'GREENHOUSE',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    );
    expect(classifyPreparationError(transient).retryable).toBe(true);

    const deterministic = new AtsError('INSPECTION_FAILED', 'selector vanished', 'GREENHOUSE');
    expect(classifyPreparationError(deterministic).retryable).toBe(false);
  });

  it('does not retry unknown errors blindly', () => {
    const cls = classifyPreparationError(new Error('something odd happened'));
    expect(cls).toEqual({ code: 'PREPARATION_FAILED', retryable: false });
  });

  it('bounds retries (no infinite retry loops)', () => {
    expect(PREPARATION_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(PREPARATION_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});

describe('safe automation run view', () => {
  const baseRun = {
    id: 'run_1',
    userId: 'user_1',
    applicationId: 'app_1',
    provider: 'PLAYWRIGHT',
    status: 'FAILED',
    startedAt: new Date('2026-10-03T10:00:00Z'),
    completedAt: new Date('2026-10-03T10:05:00Z'),
    errorMessage: 'boom at https://x.example/a?token=zzz',
    metadata: { errorCode: 'TRANSIENT_FAILURE', lastUrl: 'https://x.example/form', secret: 'nope' },
    createdAt: new Date('2026-10-03T09:59:00Z'),
    updatedAt: new Date('2026-10-03T10:05:00Z'),
  } as never;

  it('exposes identifiers, status, timestamps, and safe error info only', () => {
    const view = safeAutomationRunView(baseRun);
    expect(view).toEqual({
      id: 'run_1',
      applicationId: 'app_1',
      provider: 'PLAYWRIGHT',
      status: 'FAILED',
      startedAt: '2026-10-03T10:00:00.000Z',
      completedAt: '2026-10-03T10:05:00.000Z',
      errorCode: 'TRANSIENT_FAILURE',
      errorMessage: 'boom at https://x.example/a?…',
      createdAt: '2026-10-03T09:59:00.000Z',
      updatedAt: '2026-10-03T10:05:00.000Z',
    });
  });

  it('never exposes raw metadata (no URLs, no Redis/worker internals)', () => {
    const view = safeAutomationRunView(baseRun) as Record<string, unknown>;
    expect(view).not.toHaveProperty('metadata');
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('lastUrl');
  });
});
