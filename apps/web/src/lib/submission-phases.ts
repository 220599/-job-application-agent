import type { SubmissionPhase } from './api';

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning';

// Phase -> badge presentation, shared by every surface that shows application
// status (jobs list, applications list, application review). The phase is
// derived server-side from authoritative state only; the UI never turns an
// unknown outcome into a success and never fabricates progress.
export const PHASE_PRESENTATION: Record<
  SubmissionPhase,
  { label: string; variant: BadgeVariant }
> = {
  PREPARATION_REQUIRED: { label: 'Preparation required', variant: 'secondary' },
  PREPARING: { label: 'Preparing', variant: 'secondary' },
  AWAITING_APPROVAL: { label: 'Awaiting approval', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'default' },
  PROCESSING: { label: 'Processing', variant: 'warning' },
  SUBMITTED: { label: 'Submitted', variant: 'success' },
  PROVIDER_REJECTED: { label: 'Rejected by provider', variant: 'destructive' },
  FAILED_BEFORE_SUBMISSION: {
    label: 'Failed before submission',
    variant: 'destructive',
  },
  SECURITY_CHALLENGE: { label: 'Security challenge', variant: 'destructive' },
  OUTCOME_UNKNOWN: { label: 'Outcome unknown', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'outline' },
  CLOSED: { label: 'Closed', variant: 'outline' },
};
