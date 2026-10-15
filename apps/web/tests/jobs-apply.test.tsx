import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/api', () => ({
  jobsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    calculateMatch: vi.fn(),
    getMatch: vi.fn(),
  },
  applicationsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    prepare: vi.fn(),
    approve: vi.fn(),
    submit: vi.fn(),
  },
  resumeApi: {
    list: vi.fn(),
    getVersion: vi.fn(),
  },
}));

import {
  jobsApi,
  applicationsApi,
  resumeApi,
  type ApplicationSummary,
  type SubmissionStatusView,
} from '@/lib/api';
import JobsPage from '@/app/jobs/page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <JobsPage />
    </QueryClientProvider>
  );
}

const baseJob = {
  id: 'job-1',
  userId: 'u1',
  source: 'GREENHOUSE',
  ats: 'GREENHOUSE',
  url: 'https://example.com/job-1',
  applicationUrl: 'https://job-boards.greenhouse.io/testco/jobs/1',
  company: 'TestCo',
  title: 'Engineer',
  location: 'Remote',
  salaryCurrency: 'USD',
  discoveredAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  jobMatches: [],
  applySupported: true,
};

const approvedVersion = {
  id: 'ver-1',
  resumeId: 'res-1',
  versionNumber: 2,
  filePath: 'test/f.txt',
  source: 'TAILORED',
  reviewStatus: 'APPROVED' as const,
  createdAt: '2026-10-01T00:00:00.000Z',
};

const baseResume = {
  id: 'res-1',
  userId: 'u1',
  name: 'My Resume',
  originalFileName: 'resume.pdf',
  fileType: 'pdf',
  storageKey: 'test/resume.pdf',
  fileSize: 10,
  mimeType: 'application/pdf',
  isDefault: true,
  versions: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function statusView(
  phase: SubmissionStatusView['phase'],
  overrides: Partial<SubmissionStatusView> = {}
): SubmissionStatusView {
  return {
    phase,
    code: null,
    safeToRetry: true,
    requiresHumanResolution: false,
    guidance: 'test guidance',
    ...overrides,
  };
}

function applicationRow(
  phase: SubmissionStatusView['phase'],
  overrides: Partial<ApplicationSummary> = {}
): ApplicationSummary {
  return {
    id: 'app-1',
    jobId: 'job-1',
    status: 'DISCOVERED',
    errorCode: null,
    errorMessage: null,
    applicationUrl: baseJob.applicationUrl,
    externalApplicationId: null,
    submittedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    job: { title: baseJob.title, company: baseJob.company, url: null, ats: 'GREENHOUSE' },
    submissionStatus: statusView(phase),
    ...overrides,
  };
}

type Paged<T> = { data: T[]; pagination: { page: number; pageSize: number; total: number } };
const page = <T,>(data: T[]): Paged<T> => ({
  data,
  pagination: { page: 1, pageSize: 20, total: data.length },
});

function mockApis(opts: {
  jobs?: unknown[];
  applications?: ApplicationSummary[];
  resumeVersions?: unknown[];
} = {}) {
  vi.mocked(jobsApi.list).mockResolvedValue(page(opts.jobs ?? [baseJob]) as never);
  vi.mocked(applicationsApi.list).mockResolvedValue(
    page(opts.applications ?? []) as never
  );
  vi.mocked(resumeApi.list).mockResolvedValue(page([baseResume]) as never);
  vi.mocked(resumeApi.getVersion).mockResolvedValue(
    page(opts.resumeVersions ?? [approvedVersion]) as never
  );
}

describe('Jobs page - the Apply action', () => {
  it('shows an enabled Apply button for an eligible job', async () => {
    mockApis();
    renderPage();

    expect(await screen.findByText('Ready to apply')).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    // Resume selection is offered and preselects the default approved version.
    expect(screen.getByRole('combobox', { name: 'Resume for Engineer' })).toBeTruthy();
  });

  it('Apply starts the existing workflow: create, then prepare, with the selected resume', async () => {
    mockApis();
    vi.mocked(applicationsApi.create).mockResolvedValue({
      data: applicationRow('PREPARATION_REQUIRED'),
      alreadyExists: false,
    } as never);
    vi.mocked(applicationsApi.prepare).mockResolvedValue({ automationRun: {} } as never);

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(applicationsApi.create).toHaveBeenCalledWith({
        jobId: 'job-1',
        resumeVersionId: 'ver-1',
      })
    );
    await waitFor(() =>
      expect(applicationsApi.prepare).toHaveBeenCalledWith('app-1')
    );
  });

  it('a rapid second click cannot fire a second create request', async () => {
    mockApis();
    let resolveCreate: (value: unknown) => void = () => undefined;
    vi.mocked(applicationsApi.create).mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }) as never
    );
    vi.mocked(applicationsApi.prepare).mockResolvedValue({ automationRun: {} } as never);

    renderPage();
    const apply = await screen.findByRole('button', { name: 'Apply' });
    // Three synchronous clicks: only the first may ever start a request
    // (mutationFn is invoked on a microtask, so the first call is awaited).
    fireEvent.click(apply);
    fireEvent.click(apply);
    fireEvent.click(apply);
    await waitFor(() => expect(applicationsApi.create).toHaveBeenCalledTimes(1));
    expect(applicationsApi.create).toHaveBeenCalledTimes(1);

    // While pending the button shows progress and is disabled.
    const pending = await screen.findByRole('button', { name: /Applying/i });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(applicationsApi.create).toHaveBeenCalledTimes(1);

    resolveCreate({ data: applicationRow('PREPARATION_REQUIRED'), alreadyExists: false });
    await waitFor(() => expect(applicationsApi.prepare).toHaveBeenCalledWith('app-1'));
    expect(applicationsApi.create).toHaveBeenCalledTimes(1);
  });

  it('an unsupported board is reported honestly with no Apply button', async () => {
    mockApis({ jobs: [{ ...baseJob, applySupported: false }] });
    renderPage();

    expect(await screen.findByText('Unsupported board')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(screen.getByText(/apply\s+manually/i)).toBeTruthy();
  });

  it('without an approved resume version the UI points at the review flow instead of applying', async () => {
    mockApis({ resumeVersions: [] });
    renderPage();

    expect(await screen.findByText('Resume not approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(
      screen.getByText('Review and approve a resume version')
    ).toBeTruthy();
  });

  it('an already-submitted application shows the persisted status and no Apply button', async () => {
    mockApis({
      applications: [
        applicationRow('SUBMITTED', {
          status: 'SUBMITTED',
          submittedAt: '2026-10-02T10:00:00.000Z',
          externalApplicationId: 'ext-123',
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText('Submitted')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume preparation' })).toBeNull();
    expect(screen.getByText('Review application')).toBeTruthy();
  });

  it('a failed application offers preparation resume but never claims success', async () => {
    mockApis({
      applications: [
        applicationRow('FAILED_BEFORE_SUBMISSION', { status: 'FAILED', errorCode: 'TRANSIENT_FAILURE' }),
      ],
    });
    renderPage();

    expect(await screen.findByText('Failed before submission')).toBeTruthy();
    expect(screen.queryByText('Submitted')).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume preparation' })).toBeTruthy();
    expect(screen.queryByText(/Application created/)).toBeNull();
  });

  it('an unknown outcome is shown as such and never gets an automatic retry', async () => {
    mockApis({
      applications: [
        applicationRow('OUTCOME_UNKNOWN', {
          submissionStatus: statusView('OUTCOME_UNKNOWN', {
            safeToRetry: false,
            requiresHumanResolution: true,
          }),
        }),
      ],
    });
    renderPage();

    expect(await screen.findByText('Outcome unknown')).toBeTruthy();
    expect(screen.queryByText('Submitted')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume preparation' })).toBeNull();
  });

  it('API errors are surfaced instead of a fake success message', async () => {
    mockApis();
    vi.mocked(applicationsApi.create).mockRejectedValue(
      new Error('Request validation failed')
    );

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('Request validation failed')).toBeTruthy();
    expect(screen.queryByText(/Application created/)).toBeNull();
  });

  it('restores status purely from the API (a refresh shows the persisted state)', async () => {
    // First load: nothing applied yet.
    mockApis();
    const first = renderPage();
    expect(await first.findByText('Ready to apply')).toBeTruthy();
    first.unmount();

    // "Refresh": the API now reports a persisted application awaiting approval.
    mockApis({ applications: [applicationRow('AWAITING_APPROVAL', { status: 'READY_FOR_REVIEW' })] });
    renderPage();

    expect(await screen.findByText('Awaiting approval')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });
});
