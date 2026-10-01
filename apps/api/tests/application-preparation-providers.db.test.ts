import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Load DATABASE_URL before @jaa/database instantiates Prisma.
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

import type { MockGreenhouseServer } from '../../packages/greenhouse/tests/fixtures/mock-greenhouse-server';
import type { MockLeverServer } from '../../packages/lever/tests/fixtures/mock-lever-server';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/jaa_dev';

// Database-dependent tests are skipped when no database is reachable
// (same convention as the rest of the repo: unit tests stay deterministic).
const HAS_DB = Boolean(process.env.DATABASE_URL);

const { prisma } = await import('@jaa/database');
const { prepareApplication } = await import('@jaa/core');
const { AtsRegistry } = await import('@jaa/ats');
const { registerGreenhouseAdapter } = await import('../../packages/greenhouse/src');
const { registerLeverAdapter } = await import('../../packages/lever/src');
const { startMockGreenhouseServer } = await import(
  '../../packages/greenhouse/tests/fixtures/mock-greenhouse-server'
);
const { startMockLeverServer } = await import(
  '../../packages/lever/tests/fixtures/mock-lever-server'
);

const TEST_USER_ID = 'providers-db-user';

let greenhouse: MockGreenhouseServer;
let lever: MockLeverServer;
let jobId: string;
let resumeVersionId: string;
let greenhouseApplicationId: string;
let leverApplicationId: string;

async function createTestApplication(applicationUrl: string, ats: string) {
  return prisma.application.create({
    data: {
      userId: TEST_USER_ID,
      jobId,
      resumeVersionId,
      ats,
      applicationUrl,
      status: 'DISCOVERED',
    },
  });
}

describe.skipIf(!HAS_DB)('provider adapters end-to-end (database integration)', () => {
  beforeAll(async () => {
    greenhouse = await startMockGreenhouseServer();
    lever = await startMockLeverServer();

    // Fixture chain required by the Application FKs: user, job, resume+version.
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      update: {},
      create: { id: TEST_USER_ID, email: 'providers-db-user@test.local', name: 'Providers DB User' },
    });

    const job = await prisma.job.create({
      data: {
        userId: TEST_USER_ID,
        source: 'GREENHOUSE',
        url: `https://example.com/providers-db-test-job-${Date.now()}`,
        company: 'Provider Test Co',
        title: 'Providers DB Test Role',
        description: 'Deterministic provider integration test job',
      },
    });
    jobId = job.id;

    const resume = await prisma.resume.create({
      data: {
        userId: TEST_USER_ID,
        name: 'Providers DB test resume',
        originalFileName: 'fake-resume.txt',
        fileType: 'pdf',
        storageKey: 'test/providers-db-fake-resume.txt',
        fileSize: 10,
        mimeType: 'application/pdf',
      },
    });
    const version = await prisma.resumeVersion.create({
      data: { resumeId: resume.id, versionNumber: 1, filePath: 'test/providers-db-fake-resume.txt' },
    });
    resumeVersionId = version.id;

    greenhouseApplicationId = (await createTestApplication(greenhouse.url, 'GREENHOUSE')).id;
    leverApplicationId = (await createTestApplication(lever.url, 'LEVER')).id;
  });

  afterAll(async () => {
    await prisma.application.deleteMany({
      where: { id: { in: [greenhouseApplicationId, leverApplicationId] } },
    });
    await prisma.resume.deleteMany({ where: { userId: TEST_USER_ID, name: 'Providers DB test resume' } });
    await prisma.job.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({ where: { id: TEST_USER_ID } });
    await greenhouse.close();
    await lever.close();
    await prisma.$disconnect();
  });

  it('Greenhouse: URL -> registry -> adapter -> inspection -> questions -> FORM_INSPECTED', async () => {
    const registry = new AtsRegistry();
    const adapter = registerGreenhouseAdapter(registry, { extraBoardHosts: ['127.0.0.1'] });

    // Registry resolution claims the fixture URL through the provider adapter.
    expect(registry.findForUrl(greenhouse.url)).toBe(adapter);

    const result = await prepareApplication({
      applicationId: greenhouseApplicationId,
      registry,
      allowPrivateUrls: true,
    });

    expect(result.status).toBe('FORM_INSPECTED'); // lifecycle stops here - never SUBMITTED
    expect(result.provider).toBe('GREENHOUSE');
    expect(result.inspection?.isApplicationForm).toBe(true);
    expect(result.questionsPersisted).toBe(16);

    const questions = await prisma.applicationQuestion.findMany({
      where: { applicationId: greenhouseApplicationId },
    });
    expect(questions).toHaveLength(16);
    const byExternalId = new Map(questions.map((q) => [q.externalFieldId, q]));

    const types = new Set(questions.map((q) => q.fieldType));
    expect(types).toContain('TEXT');
    expect(types).toContain('EMAIL');
    expect(types).toContain('PHONE');
    expect(types).toContain('TEXTAREA');
    expect(types).toContain('SELECT');
    expect(types).toContain('FILE');
    expect(questions.filter((q) => q.required)).toHaveLength(10);

    // Options of a Greenhouse custom dropdown persisted as JSON.
    const workAuth = byExternalId.get('question_70000004');
    expect(workAuth?.fieldType).toBe('SELECT');
    expect(workAuth?.options).toEqual([
      { value: 'Yes', label: 'Yes' },
      { value: 'No', label: 'No' },
    ]);

    // Stable locator + provider metadata persisted.
    const first = byExternalId.get('first_name');
    expect(first?.locator).toMatchObject({
      cssSelector: '#first_name',
      attributes: { id: 'first_name', semantic: 'first_name' },
    });
    const resume = questions.find((q) => q.locator !== null && (q.locator as Record<string, any>).attributes?.semantic === 'resume');
    expect(resume?.fieldType).toBe('FILE');
  });

  it('Greenhouse: re-inspection is idempotent and stays at FORM_INSPECTED', async () => {
    const registry = new AtsRegistry();
    registerGreenhouseAdapter(registry, { extraBoardHosts: ['127.0.0.1'] });

    const result = await prepareApplication({
      applicationId: greenhouseApplicationId,
      registry,
      allowPrivateUrls: true,
    });
    expect(result.questionsPersisted).toBe(0);
    expect(result.status).toBe('FORM_INSPECTED');

    const questions = await prisma.applicationQuestion.findMany({
      where: { applicationId: greenhouseApplicationId },
    });
    expect(questions).toHaveLength(16);
  });

  it('Greenhouse: audit events and a single AutomationRun are recorded', async () => {
    const events = await prisma.applicationEvent.findMany({
      where: { applicationId: greenhouseApplicationId },
      orderBy: { createdAt: 'asc' },
    });
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('FORM_OPENED');
    expect(eventTypes).toContain('FORM_INSPECTED');
    expect(eventTypes).not.toContain('SUBMISSION_STARTED');
    expect(eventTypes).not.toContain('SUBMISSION_COMPLETED');

    const run = await prisma.automationRun.findUnique({
      where: { applicationId: greenhouseApplicationId },
    });
    expect(run).not.toBeNull();
    expect(run!.provider).toBe('GREENHOUSE');
    expect(run!.status).toBe('COMPLETED');
    expect(String((run!.metadata as Record<string, unknown>).lastUrl)).toBe(`${greenhouse.url}/`);
  });

  it('Lever: URL -> registry -> adapter -> inspection -> questions -> FORM_INSPECTED', async () => {
    const registry = new AtsRegistry();
    const adapter = registerLeverAdapter(registry, { extraBoardHosts: ['127.0.0.1'] });

    expect(registry.findForUrl(lever.url)).toBe(adapter);

    const result = await prepareApplication({
      applicationId: leverApplicationId,
      registry,
      allowPrivateUrls: true,
    });

    expect(result.status).toBe('FORM_INSPECTED'); // lifecycle stops here - never SUBMITTED
    expect(result.provider).toBe('LEVER');
    expect(result.inspection?.isApplicationForm).toBe(true);
    expect(result.questionsPersisted).toBe(17);

    const questions = await prisma.applicationQuestion.findMany({
      where: { applicationId: leverApplicationId },
    });
    expect(questions).toHaveLength(17);
    const byExternalId = new Map(questions.map((q) => [q.externalFieldId, q]));

    const types = new Set(questions.map((q) => q.fieldType));
    expect(types).toContain('TEXT');
    expect(types).toContain('EMAIL');
    expect(types).toContain('PHONE');
    expect(types).toContain('TEXTAREA');
    expect(types).toContain('SELECT');
    expect(types).toContain('RADIO');
    expect(types).toContain('CHECKBOX');
    expect(types).toContain('FILE');
    expect(questions.filter((q) => q.required)).toHaveLength(8);

    // Radio options + semantic metadata persisted.
    const workAuth = byExternalId.get('cards[1c719ca9-0000-0000-0000-000000000002][field0]');
    expect(workAuth?.fieldType).toBe('RADIO');
    expect(workAuth?.options).toEqual([
      { value: 'Yes', label: 'Yes' },
      { value: 'No', label: 'No' },
    ]);
    expect(workAuth?.locator).toMatchObject({
      attributes: { semantic: 'work_authorization' },
    });
    expect(workAuth?.section).toBe('Work Authorization');

    const email = byExternalId.get('email');
    expect(email?.fieldType).toBe('EMAIL');
    expect(email?.locator).toMatchObject({
      cssSelector: '[name="email"]',
      attributes: { 'data-qa': 'email-input', semantic: 'email' },
    });
  });

  it('Lever: re-inspection is idempotent and stays at FORM_INSPECTED', async () => {
    const registry = new AtsRegistry();
    registerLeverAdapter(registry, { extraBoardHosts: ['127.0.0.1'] });

    const result = await prepareApplication({
      applicationId: leverApplicationId,
      registry,
      allowPrivateUrls: true,
    });
    expect(result.questionsPersisted).toBe(0);
    expect(result.status).toBe('FORM_INSPECTED');

    const questions = await prisma.applicationQuestion.findMany({
      where: { applicationId: leverApplicationId },
    });
    expect(questions).toHaveLength(17);
  });

  it('Lever: audit events and a single AutomationRun are recorded', async () => {
    const events = await prisma.applicationEvent.findMany({
      where: { applicationId: leverApplicationId },
      orderBy: { createdAt: 'asc' },
    });
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('FORM_OPENED');
    expect(eventTypes).toContain('FORM_INSPECTED');
    expect(eventTypes).not.toContain('SUBMISSION_STARTED');

    const run = await prisma.automationRun.findUnique({
      where: { applicationId: leverApplicationId },
    });
    expect(run).not.toBeNull();
    expect(run!.provider).toBe('LEVER');
    expect(run!.status).toBe('COMPLETED');
    expect(String((run!.metadata as Record<string, unknown>).lastUrl)).toBe(`${lever.url}/`);
  });

  it('never submits an application through either provider', async () => {
    expect(greenhouse.submissions).toHaveLength(0);
    expect(lever.submissions).toHaveLength(0);

    for (const id of [greenhouseApplicationId, leverApplicationId]) {
      const app = await prisma.application.findUnique({ where: { id } });
      expect(app?.status).toBe('FORM_INSPECTED');
      expect(app?.submittedAt).toBeNull();
    }
  });
});
