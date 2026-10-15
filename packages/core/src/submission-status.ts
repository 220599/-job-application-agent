import { prisma } from '@jaa/database';
import type { ApplicationStatus } from '@jaa/database';

/**
 * Phase 15D - user-facing submission status.
 *
 * One derived, PII-free view that tells the user exactly what is going on
 * with an application and what (if anything) they must do next. It is derived
 * from AUTHORITATIVE state only: the Application status, the persisted error
 * code, and the submission-attempt ledger - never from queue completion
 * alone, never from anything a client supplied. An unknown outcome is never
 * presented as a success, and no progress or provider reference is ever
 * fabricated.
 */

export type SubmissionPhase =
  | 'PREPARATION_REQUIRED'
  | 'PREPARING'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'PROCESSING'
  | 'SUBMITTED'
  | 'PROVIDER_REJECTED'
  | 'FAILED_BEFORE_SUBMISSION'
  | 'SECURITY_CHALLENGE'
  | 'OUTCOME_UNKNOWN'
  | 'CANCELLED'
  | 'CLOSED';

export interface SubmissionStatusView {
  phase: SubmissionPhase;
  /** Stable machine code (the persisted errorCode) when one is recorded. */
  code: string | null;
  /**
   * True when a NEW submission attempt cannot create a duplicate application.
   * False for unknown outcomes: the provider may already have accepted an
   * application, so nothing may be sent again until a human resolves it.
   */
  safeToRetry: boolean;
  /** The user must resolve this manually before anything else can happen. */
  requiresHumanResolution: boolean;
  /** Short actionable guidance - no secrets, no sensitive diagnostics. */
  guidance: string;
}

export interface SubmissionStatusInput {
  status: ApplicationStatus;
  errorCode: string | null;
  /** Status of the application's automation run, when one exists. */
  runStatus?: string | null;
  /** True while the submission-attempt ledger holds an UNRESOLVED attempt. */
  hasUnresolvedAttempt?: boolean;
}

const GUIDANCE: Record<SubmissionPhase, string> = {
  PREPARATION_REQUIRED:
    'Prepare the application to inspect its form and questions before review.',
  PREPARING:
    'Preparation is running. Questions become available for review when it completes.',
  AWAITING_APPROVAL:
    'Review the prepared application and approve it explicitly to enable submission.',
  APPROVED:
    'Approved for submission. Submit when you are ready - the approved content is locked until then.',
  PROCESSING:
    'The submission is being processed. The outcome appears here once the provider answers.',
  SUBMITTED: 'Submission confirmed by the provider.',
  PROVIDER_REJECTED:
    'The provider refused the submission and no application was created. Review the application, then prepare and approve it again to retry.',
  FAILED_BEFORE_SUBMISSION:
    'The submission failed before it could be confirmed as received. You can prepare and approve the application again to retry safely.',
  SECURITY_CHALLENGE:
    'A security challenge (such as a CAPTCHA) stopped the submission; it is never solved automatically. Complete the application manually on the employer site if you wish to continue.',
  OUTCOME_UNKNOWN:
    'The submission result is unknown and needs your resolution: check with the employer before doing anything else. The system will never resubmit automatically.',
  CANCELLED: 'The application was cancelled or withdrawn.',
  CLOSED: 'The application is closed.',
};

/**
 * Pure derivation of the user-facing status. Queue state only refines an
 * in-progress phase - a COMPLETED run alone NEVER means the submission
 * succeeded (only SUBMITTED, recorded from provider evidence, does).
 */
export function deriveSubmissionStatus(input: SubmissionStatusInput): SubmissionStatusView {
  const code = input.errorCode ?? null;

  // The unknown-outcome ledger is authoritative over everything else: while
  // an attempt is unresolved the result genuinely is unknown.
  if (input.hasUnresolvedAttempt || code === 'SUBMISSION_OUTCOME_UNKNOWN') {
    return {
      phase: 'OUTCOME_UNKNOWN',
      code: 'SUBMISSION_OUTCOME_UNKNOWN',
      safeToRetry: false,
      requiresHumanResolution: true,
      guidance: GUIDANCE.OUTCOME_UNKNOWN,
    };
  }

  switch (input.status) {
    case 'SUBMITTED':
      return view('SUBMITTED', code, true, false);
    case 'SUBMITTING':
      return view('PROCESSING', code, false, false);
    case 'WITHDRAWN':
      return view('CANCELLED', code, true, false);
    case 'REJECTED':
      return view('CLOSED', code, true, false);
    case 'INTERVIEW':
    case 'OFFER':
      return {
        phase: 'SUBMITTED',
        code,
        safeToRetry: true,
        requiresHumanResolution: false,
        guidance:
          'The application is progressing in the employer pipeline; no action is needed here.',
      };
    case 'APPROVED':
      // An active submission run means the request is in flight (the worker
      // has not claimed SUBMITTING yet) - still PROCESSING, never success.
      if (input.runStatus === 'QUEUED' || input.runStatus === 'RUNNING') {
        return view('PROCESSING', code, false, false);
      }
      return view('APPROVED', code, true, false);
    case 'FORM_INSPECTED':
    case 'READY_FOR_REVIEW':
      return view('AWAITING_APPROVAL', code, true, false);
    case 'PREPARING':
      return view('PREPARING', code, true, false);
    case 'DISCOVERED':
    case 'MATCHED':
      // An active preparation run means the request is in flight (the worker
      // has not claimed PREPARING yet) - report Preparing, never "ready to
      // apply", so the user never sees a queued application look idle.
      if (input.runStatus === 'QUEUED' || input.runStatus === 'RUNNING') {
        return view('PREPARING', code, true, false);
      }
      return view('PREPARATION_REQUIRED', code, true, false);
    case 'FAILED': {
      if (code === 'CAPTCHA_DETECTED' || code === 'SECURITY_CHALLENGE') {
        return view('SECURITY_CHALLENGE', code, true, false);
      }
      if (code === 'SUBMISSION_FAILED') {
        // A definitive provider refusal: the documented contract says no
        // application was created, so a new attempt cannot duplicate one.
        return view('PROVIDER_REJECTED', code, true, false);
      }
      if (code === 'TRANSIENT_FAILURE' || code === 'PROVIDER_UNAVAILABLE' || code === 'ENQUEUE_FAILED') {
        return view('FAILED_BEFORE_SUBMISSION', code, true, false);
      }
      // Deterministic preparation/submission failures never transmitted
      // anything - a fresh (approved) attempt is safe.
      return view('FAILED_BEFORE_SUBMISSION', code, true, false);
    }
    default:
      return view('PREPARATION_REQUIRED', code, true, false);
  }
}

function view(
  phase: SubmissionPhase,
  code: string | null,
  safeToRetry: boolean,
  requiresHumanResolution: boolean
): SubmissionStatusView {
  return {
    phase,
    code,
    safeToRetry,
    requiresHumanResolution,
    guidance: GUIDANCE[phase],
  };
}

type ApplicationRow = Pick<
  import('@prisma/client').Application,
  'id' | 'status' | 'errorCode'
>;

/**
 * Load the authoritative inputs (automation run state + the submission-attempt
 * ledger) and derive the status view for many applications in two queries.
 */
export async function getSubmissionStatuses(
  applications: ApplicationRow[]
): Promise<Map<string, SubmissionStatusView>> {
  const ids = applications.map((application) => application.id);
  const [runs, unresolved] = await Promise.all([
    ids.length > 0
      ? prisma.automationRun.findMany({ where: { applicationId: { in: ids } } })
      : Promise.resolve([]),
    // Imported lazily to keep this module free of import cycles.
    import('./application-submission').then((m) =>
      m.findUnresolvedSubmissionAttempts(ids)
    ),
  ]);
  const runByApplication = new Map(runs.map((run) => [run.applicationId, run]));
  const result = new Map<string, SubmissionStatusView>();
  for (const application of applications) {
    result.set(
      application.id,
      deriveSubmissionStatus({
        status: application.status,
        errorCode: application.errorCode,
        runStatus: runByApplication.get(application.id)?.status ?? null,
        hasUnresolvedAttempt: unresolved.has(application.id),
      })
    );
  }
  return result;
}

/** Single-application form of {@link getSubmissionStatuses}. */
export async function getSubmissionStatus(
  application: ApplicationRow
): Promise<SubmissionStatusView> {
  const statuses = await getSubmissionStatuses([application]);
  return statuses.get(application.id)!;
}
