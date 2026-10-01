import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Load DATABASE_URL before @jaa/database instantiates Prisma.
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

import type { MockAtsServer } from '../../packages/ats/tests/fixtures/mock-ats-server';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/jaa_dev';

// Database-dependent tests are skipped when no database is reachable
// (same convention as the rest of the repo: unit tests stay deterministic).
const HAS_DB = Boolean(process.env.DATABASE_URL);

const { prisma } = await import('@jaa/database');
const { prepareApplication } = await import('@jaa/core');
const { AtsError } = await import('@jaa/ats');
const { MockAtsAdapter } = await import('../../packages/ats/tests/fixtures/mock-adapter');
const { startMockAtsServer } = await import(
  '../../packages/ats/tests/fixtures/mock-ats-server'
);

const TEST_USER_ID = 'dev-user-123';
const TEST_JOB_URL = `https://example.com/phase7-db-test-job-${Date.now()}`;

let mock: MockAtsServer;
let jobId: string;
let resumeVersionId: string;
let applicationId: string;
let unsupportedApplicationId: string;

async function createTestApplication(overrides?: { applicationUrl?: string; status?: 'DISCOVERED' | 'SUBMITTED' }) {
  const application = await prisma.application.create({
    data: {
      userId: TEST_USER_ID,
      jobId,
      resumeVersionId,
      ats: 'MOCK',
      applicationUrl: overrides?.applicationUrl ?? mock.url,
      status: overrides?.status ?? 'DISCOVERED',
    },
  });
  return application;
}

describe.skipIf(!HAS_DB)('application preparation (database integration)', () => {
  beforeAll(async () => {
    mock = await startMockAtsServer();

    // Fixture chain required by the Application FKs: user, job, resume+version.
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: 'dev-user-123@test.local', name: 'Dev User' },
    });

    const job = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'MOCK',
        url: TEST_JOB_URL,
        company: 'Mock Corp',
        title: 'Phase 7 Test Role',
        description: 'Deterministic test job',
      },
    });
    jobId = job.id;

    const resume = await prisma.resume.create({
      data: {
        userId: TEST_USER_ID,
        name: 'Phase 7 test resume',
        originalFileName: 'fake-resume.txt',
        fileType: 'pdf',
        storageKey: 'test/phase7-fake-resume.txt',
        fileSize: 10,
        mimeType: 'application/pdf',
      },
    });
    const version = await prisma.resumeVersion.create({
      data: { resumeId: resume.id, versionNumber: 1, filePath: 'test/phase7-fake-resume.txt' },
    });
    resumeVersionId = version.id;

    const application = await createTestApplication();
    applicationId = application.id;

    const unsupported = await createTestApplication({
      applicationUrl: 'https://no-adapter-for-this.example.com/apply/1',
    });
    unsupportedApplicationId = unsupported.id;
  });

  afterAll(async () => {
    // Cascades remove questions, events and the automation run.
    await prisma.application.deleteMany({ where: { id: { in: [applicationId, unsupportedApplicationId] } } });
    await prisma.resume.deleteMany({ where: { userId: TEST_USER_ID, name: 'Phase 7 test resume' } });
    await prisma.job.deleteMany({ where: { id: jobId } });
    await mock.close();
    await prisma.$disconnect();
  });

  it('inspects the application and persists ApplicationQuestion rows', async () => {
    const registry = new (await import('@jaa/ats')).AtsRegistry();
    registry.register(new MockAtsAdapter());

    const result = await prepareApplication({
      applicationId,
      registry,
      allowPrivateUrls: true,
    });

    expect(result.status).toBe('FORM_INSPECTED'); // Phase 7 stops here - never SUBMITTED
    expect(result.provider).toBe('MOCK');
    expect(result.questionsPersisted).toBe(5);

    // Questions belong to the correct application
    const questions = await prisma.applicationQuestion.findMany({
      where: { applicationId },
    });
    expect(questions).toHaveLength(5);
    expect(questions.every((q) => q.applicationId === applicationId)).toBe(true);

    const types = new Set(questions.map((q) => q.fieldType));
    expect(types).toContain('TEXT');
    expect(types).toContain('EMAIL');
    expect(types).toContain('SELECT');
    expect(types).toContain('FILE');
    const requiredCount = questions.filter((q) => q.required).length;
    expect(requiredCount).toBe(4);
  });

  it('does not duplicate questions on repeated inspection and stays idempotent', async () => {
    const registry = new (await import('@jaa/ats')).AtsRegistry();
    registry.register(new MockAtsAdapter());

    const result = await prepareApplication({ applicationId, registry, allowPrivateUrls: true });
    expect(result.questionsPersisted).toBe(0); // everything already persisted

    const questions = await prisma.applicationQuestion.findMany({ where: { applicationId } });
    expect(questions).toHaveLength(5);
    expect(result.status).toBe('FORM_INSPECTED');
  });

  it('progresses status deterministically and writes audit events', async () => {
    const events = await prisma.applicationEvent.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'asc' },
    });
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('FORM_OPENED');
    expect(eventTypes).toContain('FORM_INSPECTED');

    const inspected = events.find((e) => e.eventType === 'FORM_INSPECTED');
    expect(inspected?.status).toBe('FORM_INSPECTED');
    expect(inspected?.metadata).toMatchObject({ provider: 'MOCK' });
  });

  it('records a single AutomationRun per application (unique applicationId)', async () => {
    const run = await prisma.automationRun.findUnique({ where: { applicationId } });
    expect(run).not.toBeNull();
    expect(run!.provider).toBe('MOCK');
    expect(run!.status).toBe('COMPLETED');
    expect(run!.startedAt).not.toBeNull();
    expect(run!.completedAt).not.toBeNull();
    // The browser layer normalizes the URL (adds the trailing slash).
    expect(String((run!.metadata as Record<string, unknown>).lastUrl)).toBe(`${mock.url}/`);
  });

  it('marks FAILED with an event when no adapter supports the ATS', async () => {
    const registry = new (await import('@jaa/ats')).AtsRegistry();
    registry.register(new MockAtsAdapter()); // cannot handle the unsupported URL

    await expect(
      prepareApplication({ applicationId: unsupportedApplicationId, registry })
    ).rejects.toThrowError(AtsError);

    const app = await prisma.application.findUnique({ where: { id: unsupportedApplicationId } });
    expect(app?.status).toBe('FAILED');
    const errorEvents = await prisma.applicationEvent.findMany({
      where: { applicationId: unsupportedApplicationId, eventType: 'ERROR' },
    });
    expect(errorEvents.length).toBe(1);
    const run = await prisma.automationRun.findUnique({ where: { applicationId: unsupportedApplicationId } });
    expect(run?.status).toBe('FAILED');
  });

  it('refuses to prepare applications in terminal statuses', async () => {
    const terminal = await createTestApplication({ status: 'SUBMITTED' });
    const registry = new (await import('@jaa/ats')).AtsRegistry();
    registry.register(new MockAtsAdapter());

    await expect(
      prepareApplication({ applicationId: terminal.id, registry, allowPrivateUrls: true })
    ).rejects.toThrowError(/INVALID_APPLICATION_STATUS/);

    await prisma.application.delete({ where: { id: terminal.id } });
  });
});
