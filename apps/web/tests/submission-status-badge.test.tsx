import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusBadge } from '@/components/submission-status-badge';
import type { SubmissionPhase, SubmissionStatusView } from '@/lib/api';

afterEach(cleanup);

function status(
  phase: SubmissionPhase,
  overrides: Partial<SubmissionStatusView> = {}
): SubmissionStatusView {
  return {
    phase,
    code: null,
    safeToRetry: phase === 'SUBMITTED',
    requiresHumanResolution: phase === 'OUTCOME_UNKNOWN',
    guidance: 'test guidance',
    ...overrides,
  };
}

describe('StatusBadge - honest status presentation', () => {
  it('never shows Submitted while the request is only queued or processing', () => {
    render(<StatusBadge status={status('PROCESSING')} />);
    expect(screen.getByText('Processing')).toBeTruthy();
    expect(screen.queryByText('Submitted')).toBeNull();
    expect(screen.queryByText('Submitting')).toBeNull();
  });

  it('shows Submitted only when the server derived it from provider evidence', () => {
    render(<StatusBadge status={status('SUBMITTED')} />);
    expect(screen.getByText('Submitted')).toBeTruthy();
  });

  it('keeps an unknown outcome visible - it is never reset to ready or submitted', () => {
    render(<StatusBadge status={status('OUTCOME_UNKNOWN')} />);
    expect(screen.getByText('Outcome unknown')).toBeTruthy();
    expect(screen.queryByText('Submitted')).toBeNull();
    expect(screen.queryByText('Ready to apply')).toBeNull();
    expect(screen.queryByText('Preparation required')).toBeNull();
  });

  it('distinguishes failure before transmission from a provider rejection', () => {
    const first = render(<StatusBadge status={status('FAILED_BEFORE_SUBMISSION')} />);
    expect(screen.getByText('Failed before submission')).toBeTruthy();
    first.unmount();

    render(<StatusBadge status={status('PROVIDER_REJECTED')} />);
    expect(screen.getByText('Rejected by provider')).toBeTruthy();
    expect(screen.queryByText('Submitted')).toBeNull();
  });

  it('distinguishes the approval and security-challenge states', () => {
    const first = render(<StatusBadge status={status('AWAITING_APPROVAL')} />);
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    first.unmount();

    render(<StatusBadge status={status('SECURITY_CHALLENGE')} />);
    expect(screen.getByText('Security challenge')).toBeTruthy();
    expect(screen.queryByText('Submitted')).toBeNull();
  });

  it('falls back to the most conservative label when the status is missing', () => {
    render(<StatusBadge status={null} />);
    expect(screen.getByText('Preparation required')).toBeTruthy();
    expect(screen.queryByText('Submitted')).toBeNull();
  });
});
