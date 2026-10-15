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
  applicationsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    prepare: vi.fn(),
    approve: vi.fn(),
    submit: vi.fn(),
  },
}));

import {
  applicationsApi,
  type ApplicationDetail,
  type ApplicationSummary,
  type SubmissionStatusView,
} from '@/lib/api';
import ApplicationsPage from '@/app/applications/page';
import ApplicationReviewPage from '@/app/applications/[id]/page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

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
  id: string,
  phase: SubmissionStatusView['phase'],
  overrides: Partial<ApplicationSummary> = {}
): ApplicationSummary {
  return {
    id,
    jobId: `job-${id}`,
    status: 'DISCOVERED',
    errorCode: null,
    errorMessage: null,
    applicationUrl: 'https://job-boards.greenhouse.io/testco/jobs/1',
    externalApplicationId: null,
    submittedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    job: { title: `Role ${id}`, company: 'TestCo', url: null, ats: 'GREENHOUSE' },
    submissionStatus: statusView(phase),
    ...overrides,
  };
}

describe('Applications list - honest canonical statuses', () => {
  it('distinguishes every phase and shows Submitted exactly once (evidence only)', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue({
      data: [
        applicationRow('a1', 'PROCESSING', { status: 'SUBMITTING' }),
        applicationRow('a2', 'AWAITING_APPROVAL', { status: 'READY_FOR_REVIEW' }),
        applicationRow('a3', 'APPROVED', { status: 'APPROVED' }),
        applicationRow('a4', 'OUTCOME_UNKNOWN', {
          status: 'SUBMITTING',
          submissionStatus: statusView('OUTCOME_UNKNOWN', {
            safeToRetry: false,
            requiresHumanResolution: true,
          }),
        }),
        applicationRow('a5', 'FAILED_BEFORE_SUBMISSION', { status: 'FAILED' }),
        applicationRow('a6', 'SECURITY_CHALLENGE', {
          status: 'FAILED',
          errorCode: 'CAPTCHA_DETECTED',
        }),
        applicationRow('a7', 'SUBMITTED', {
          status: 'SUBMITTED',
          submittedAt: '2026-10-02T10:00:00.000Z',
          externalApplicationId: 'ext-123',
        }),
      ],
      pagination: { page: 1, pageSize: 20, total: 7 },
    } as never);

    renderPage(<ApplicationsPage />);

    expect(await screen.findByText('Processing')).toBeTruthy();
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Outcome unknown')).toBeTruthy();
    expect(screen.getByText('Failed before submission')).toBeTruthy();
    expect(screen.getByText('Security challenge')).toBeTruthy();

    // Only the row with persisted provider evidence shows "Submitted".
    expect(screen.getAllByText('Submitted')).toHaveLength(1);
    expect(screen.getByText('ext-123')).toBeTruthy();
  });

  it('shows an unknown outcome as needing human resolution, not as a failure to retry', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue({
      data: [
        applicationRow('a1', 'OUTCOME_UNKNOWN', {
          submissionStatus: statusView('OUTCOME_UNKNOWN', {
            safeToRetry: false,
            requiresHumanResolution: true,
          }),
        }),
      ],
      pagination: { page: 1, pageSize: 20, total: 1 },
    } as never);

    renderPage(<ApplicationsPage />);

    expect(await screen.findByText('Outcome unknown')).toBeTruthy();
    expect(
      screen.getByText(/needs your manual resolution/i)
    ).toBeTruthy();
    expect(screen.getByText('No automatic resubmission will occur.')).toBeTruthy();
    expect(screen.queryByText('Submitted')).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Submit$/i })).toBeNull();
  });

  it('offers each action only in the state where it is legal', async () => {
    vi.mocked(applicationsApi.list).mockResolvedValue({
      data: [
        applicationRow('a1', 'AWAITING_APPROVAL', { status: 'READY_FOR_REVIEW' }),
        applicationRow('a2', 'APPROVED', { status: 'APPROVED' }),
        applicationRow('a3', 'PROCESSING', { status: 'SUBMITTING' }),
      ],
      pagination: { page: 1, pageSize: 20, total: 3 },
    } as never);

    renderPage(<ApplicationsPage />);

    await screen.findByText('Awaiting approval');
    expect(screen.getAllByRole('button', { name: /Approve/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Submit$/i })).toHaveLength(1);
  });
});

describe('Application review - queuing is never presented as success', () => {
  function detail(phase: SubmissionStatusView['phase']): ApplicationDetail {
    return {
      ...applicationRow('app-1', phase, {
        jobId: 'job-1',
        status: phase === 'APPROVED' ? 'APPROVED' : 'DISCOVERED',
      }),
      job: {
        id: 'job-1',
        title: 'Engineer',
        company: 'TestCo',
        location: 'Remote',
        url: null,
        applicationUrl: 'https://job-boards.greenhouse.io/testco/jobs/1',
        ats: 'GREENHOUSE',
      },
      resumeVersion: {
        id: 'ver-1',
        resumeId: 'res-1',
        versionNumber: 2,
        reviewStatus: 'APPROVED',
      },
      questions: [
        {
          id: 'q1',
          label: 'Why do you want this job?',
          fieldType: 'TEXTAREA',
          required: true,
          mappedSource: 'PROFILE',
          confidence: 0.9,
          currentValue: null,
          answer: {
            answer: 'Because of the mission.',
            source: 'AI_GENERATED',
            confidence: 0.9,
            needsReview: false,
            groundedFacts: ['mission'],
          },
        },
      ],
      events: [
        {
          id: 'e1',
          eventType: 'APPLICATION_CREATED',
          status: 'DISCOVERED',
          message: 'Application created from the jobs list',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };
  }

  it('reviewing shows the exact content that approval will bind', async () => {
    vi.mocked(applicationsApi.get).mockResolvedValue({
      data: detail('AWAITING_APPROVAL'),
    } as never);

    renderPage(<ApplicationReviewPage params={{ id: 'app-1' }} />);

    expect(await screen.findByText('Why do you want this job?')).toBeTruthy();
    expect(screen.getByText('Because of the mission.')).toBeTruthy();
    expect(screen.getByText(/version 2/)).toBeTruthy();
    expect(screen.getByText('Approve for submission')).toBeTruthy();
  });

  it('submitting queues the request but never claims a confirmed submission', async () => {
    const data = detail('APPROVED');
    vi.mocked(applicationsApi.get).mockResolvedValue({ data } as never);
    vi.mocked(applicationsApi.submit).mockResolvedValue({
      automationRun: {},
      enqueued: true,
    } as never);

    renderPage(<ApplicationReviewPage params={{ id: 'app-1' }} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Submit$/i }));

    await waitFor(() =>
      expect(applicationsApi.submit).toHaveBeenCalledWith('app-1')
    );
    expect(
      await screen.findByText(/This is not a confirmation yet/)
    ).toBeTruthy();
    // The badge keeps reporting the persisted status - queued is NOT submitted.
    expect(screen.queryByText('Submitted')).toBeNull();
  });
});
