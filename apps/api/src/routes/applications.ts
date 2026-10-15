import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { ApplicationStatus } from '@prisma/client';
import { paginationSchema, applicationStatusEnum } from '@jaa/shared';
import {
  generateApplicationAnswers,
  requestApplicationPreparation,
  getApplicationAutomationRun,
  cancelApplicationAutomationRun,
  approveApplicationForSubmission,
  requestApplicationSubmission,
  getSubmissionStatus,
  getSubmissionStatuses,
  createPreparationRegistry,
  isOrchestrationError,
  type OrchestrationErrorCode,
} from '@jaa/core';
import { asyncHandler } from '../middleware/auth';

const router = Router();

// Ownership guard (same convention as resumes.ts): missing auth context is a
// hard 401 before any state is touched.
function requireUser(req: Request, res: Response): string | null {
  if (!req.userId) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return null;
  }
  return req.userId;
}

// Phase 13 orchestration error codes -> HTTP status.
// Exported for the API outcome-reporting tests (Phase 15B.2 scenario 17):
// the HTTP surface must keep reporting each submission outcome honestly.
export const ORCHESTRATION_ERROR_STATUS: Record<OrchestrationErrorCode, number> = {
  APPLICATION_NOT_FOUND: 404,
  RESUME_NOT_APPROVED: 422,
  TAILORING_NOT_VALIDATED: 422,
  APPLICATION_TERMINAL: 409,
  APPLICATION_STATE_NOT_PREPARABLE: 409,
  APPLICATION_URL_MISSING: 422,
  INVALID_APPLICATION_URL: 422,
  UNSUPPORTED_ATS: 422,
  ENQUEUE_FAILED: 503,
  AUTOMATION_RUN_NOT_FOUND: 404,
  AUTOMATION_NOT_CANCELLABLE: 409,
  INVALID_JOB_PAYLOAD: 400,
  RUN_MISMATCH: 409,
  ADAPTER_NOT_FOUND: 422,
  DUPLICATE_PROVIDER: 500,
  BLOCKED_BY_SECURITY_POLICY: 422,
  INSPECTION_FAILED: 502,
  PROVIDER_UNAVAILABLE: 503,
  TRANSIENT_FAILURE: 503,
  PREPARATION_FAILED: 500,
  // Phase 15A submission gate + outcomes.
  HUMAN_APPROVAL_REQUIRED: 409,
  // Phase 15D - approval integrity (snapshot binding).
  APPROVAL_NOT_VERIFIED: 409,
  APPROVAL_STALE: 409,
  APPLICATION_STATE_NOT_SUBMITTABLE: 409,
  SUBMISSION_OUTCOME_UNKNOWN: 409,
  REQUIRED_ANSWER_MISSING: 422,
  ANSWER_NEEDS_REVIEW: 422,
  ANSWER_INVALID: 422,
  SUBMISSION_FAILED: 502,
  CAPTCHA_DETECTED: 422,
  SECURITY_CHALLENGE: 422,
};

function sendOrchestrationError(res: Response, err: unknown): void {
  if (isOrchestrationError(err)) {
    res.status(ORCHESTRATION_ERROR_STATUS[err.code] ?? 500).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }
  throw err;
}

// The approval snapshot is internal verification data (hashes + identifiers).
// It never crosses the API boundary; clients get the derived user-facing
// `submissionStatus` instead.
function safeApplicationRow<T extends object>(application: T): Omit<T, 'approvalSnapshot'> {
  const rest = { ...application } as Record<string, unknown>;
  delete rest['approvalSnapshot'];
  return rest as Omit<T, 'approvalSnapshot'>;
}

// GET /api/applications - List applications
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { page, pageSize } = paginationSchema.parse(req.query);
    const status = req.query.status as string | undefined;

    // Validate status if provided
    let whereStatus: ApplicationStatus | undefined;
    if (status) {
      try {
        whereStatus = applicationStatusEnum.parse(status) as ApplicationStatus;
      } catch {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid status value',
          },
        });
      }
    }

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        where: {
          userId,
          ...(whereStatus && { status: whereStatus }),
        },
        include: {
          job: true,
          questions: {
            include: {
              answer: true,
            },
          },
          events: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.application.count({
        where: {
          userId,
          ...(whereStatus && { status: whereStatus }),
        },
      }),
    ]);

    // Client-safe rows with the derived, authoritative submission status:
    // queue completion alone never reports success.
    const statuses = await getSubmissionStatuses(applications);
    res.json({
      data: applications.map((application) => ({
        ...safeApplicationRow(application),
        submissionStatus: statuses.get(application.id) ?? null,
      })),
      pagination: {
        page,
        pageSize,
        total,
      },
    });
  })
);

// GET /api/applications/:id - Get application details
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;

    const application = await prisma.application.findUnique({
      where: { id },
      include: {
        job: true,
        resumeVersion: true,
        questions: {
          include: {
            answer: true,
          },
        },
        events: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!application || application.userId !== userId) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Application not found',
        },
      });
    }

    res.json({
      data: {
        ...safeApplicationRow(application),
        submissionStatus: await getSubmissionStatus(application),
      },
    });
  })
);

// POST /api/applications - create (or return) the application for a job.
// This is the UI "Apply" action: the ONLY way an application comes into
// existence through the product surface (previously seed/tests only).
//
// Semantics:
//  - everything is validated BEFORE anything is created: unknown/foreign job
//    404, invalid application URL or unsupported ATS 422, unapproved/missing
//    resume 422 - refusal never leaves a partial application behind;
//  - idempotent per (user, job): a second click returns the existing row with
//    `alreadyExists: true`, never a duplicate application;
//  - it never queues anything and never claims success: preparation is a
//    separate explicit step (POST /:id/prepare) and submission requires the
//    explicit approval below. The response carries only the persisted state.
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const body = req.body ?? {};
    const { jobId, resumeVersionId } = body;
    if (typeof jobId !== 'string' || jobId.trim() === '') {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'jobId must be a non-empty string' },
      });
    }
    if (
      resumeVersionId !== undefined &&
      (typeof resumeVersionId !== 'string' || resumeVersionId.trim() === '')
    ) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'resumeVersionId must be a non-empty string',
        },
      });
    }

    const job = await prisma.job.findFirst({ where: { id: jobId, userId } });
    if (!job) {
      // Missing and foreign jobs are indistinguishable on purpose.
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    }

    // Duplicate prevention: one application per (user, job).
    const existing = await prisma.application.findFirst({
      where: { userId, jobId: job.id },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      return res.status(200).json({
        data: {
          ...safeApplicationRow(existing),
          submissionStatus: await getSubmissionStatus(existing),
        },
        alreadyExists: true,
      });
    }

    // Target validation BEFORE creating anything (same safety order as the
    // preparation gate): an invalid URL or an unsupported ATS refuses here,
    // and no application row is created.
    const applicationUrl = job.applicationUrl ?? job.url;
    let parsed: URL;
    try {
      parsed = new URL(applicationUrl);
    } catch {
      return res.status(422).json({
        error: {
          code: 'INVALID_APPLICATION_URL',
          message: 'The job has no valid application URL',
        },
      });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(422).json({
        error: {
          code: 'INVALID_APPLICATION_URL',
          message: 'Application URL must use http or https',
        },
      });
    }
    const adapter = createPreparationRegistry().findForUrl(applicationUrl);
    if (!adapter) {
      return res.status(422).json({
        error: {
          code: 'UNSUPPORTED_ATS',
          message: 'No supported ATS provider can handle this job posting',
        },
      });
    }

    // Resume selection: an explicit version must belong to the user and be
    // APPROVED; without one, resolve the default (default resume first, then
    // newest approved version). Preparation re-verifies all of this.
    let version;
    if (resumeVersionId !== undefined) {
      version = await prisma.resumeVersion.findUnique({
        where: { id: resumeVersionId },
        include: { resume: true },
      });
      if (!version || version.resume.userId !== userId) {
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Resume version not found' },
        });
      }
      if (version.reviewStatus !== 'APPROVED') {
        return res.status(422).json({
          error: {
            code: 'RESUME_NOT_APPROVED',
            message: 'The resume version must be approved before applying',
          },
        });
      }
    } else {
      version =
        (await prisma.resumeVersion.findFirst({
          where: { reviewStatus: 'APPROVED', resume: { userId, isDefault: true } },
          orderBy: { versionNumber: 'desc' },
        })) ??
        (await prisma.resumeVersion.findFirst({
          where: { reviewStatus: 'APPROVED', resume: { userId } },
          orderBy: { versionNumber: 'desc' },
        }));
      if (!version) {
        return res.status(422).json({
          error: {
            code: 'RESUME_NOT_APPROVED',
            message: 'Approve a resume version before applying',
          },
        });
      }
    }

    const application = await prisma.application.create({
      data: {
        userId,
        jobId: job.id,
        resumeVersionId: version.id,
        ats: adapter.provider,
        applicationUrl,
        status: 'DISCOVERED',
        events: {
          create: [
            {
              userId,
              eventType: 'APPLICATION_CREATED',
              status: 'DISCOVERED',
              message: 'Application created from the jobs list',
            },
            {
              userId,
              eventType: 'RESUME_SELECTED',
              message: `Approved resume version ${version.versionNumber} selected for this application`,
            },
          ],
        },
      },
    });

    return res.status(201).json({
      data: {
        ...safeApplicationRow(application),
        submissionStatus: await getSubmissionStatus(application),
      },
      alreadyExists: false,
    });
  })
);

// POST /api/applications/:id/prepare - queue asynchronous application
// preparation (Phase 13). Requires an APPROVED resume version and a supported
// ATS. Idempotent: an already-active AutomationRun is returned as-is and no
// duplicate job is queued. Stops at FORM_INSPECTED - never submits anything.
router.post(
  '/:id/prepare',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    try {
      const result = await requestApplicationPreparation({
        applicationId: req.params.id,
        userId,
      });
      res.status(202).json({ automationRun: result.automationRun });
    } catch (err) {
      sendOrchestrationError(res, err);
    }
  })
);

// GET /api/applications/:id/automation - safe AutomationRun status. Exposes
// identifiers, status, timestamps, and redacted error info only - no BullMQ
// job objects, no Redis details, no metadata, no worker internals.
router.get(
  '/:id/automation',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    try {
      const automationRun = await getApplicationAutomationRun({
        applicationId: req.params.id,
        userId,
      });
      res.json({ automationRun });
    } catch (err) {
      sendOrchestrationError(res, err);
    }
  })
);

// POST /api/applications/:id/automation/cancel - cancel a QUEUED run.
// Safe and idempotent: a RUNNING preparation owns a live browser session and
// is never terminated; cancelling twice succeeds unchanged.
router.post(
  '/:id/automation/cancel',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    try {
      const result = await cancelApplicationAutomationRun({
        applicationId: req.params.id,
        userId,
      });
      res.json({ automationRun: result.automationRun });
    } catch (err) {
      sendOrchestrationError(res, err);
    }
  })
);

// POST /api/applications/:id/approve - the EXPLICIT human approval action
// (Phase 15A). This - and nothing else - moves the application into the
// submittable APPROVED state. Approval is never inferred from resume
// approval, preparation completion, job matching, form filling, or AI
// confidence. Idempotent: approving an already-approved application is a
// no-op success.
router.post(
  '/:id/approve',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    try {
      const result = await approveApplicationForSubmission({
        applicationId: req.params.id,
        userId,
      });
      res.json({ data: result });
    } catch (err) {
      sendOrchestrationError(res, err);
    }
  })
);

// POST /api/applications/:id/submit - queue a MOCK application submission
// (Phase 15A). Runs the full submission safety gate before anything is
// enqueued: explicit human approval (status APPROVED), APPROVED resume
// version, every required answer present/resolved/valid, and a LOOPBACK
// mock ATS target (no code path can submit a real application). Idempotent:
// an already-submitted application is a no-op success, an active run is
// returned as-is, and no duplicate job is ever queued. The BullMQ payload
// is identifiers only.
router.post(
  '/:id/submit',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    try {
      const result = await requestApplicationSubmission({
        applicationId: req.params.id,
        userId,
      });
      if (result.alreadySubmitted) {
        return res.status(200).json({
          automationRun: result.automationRun,
          alreadySubmitted: true,
        });
      }
      res.status(202).json({
        automationRun: result.automationRun,
        reused: result.reused,
        enqueued: result.enqueued,
      });
    } catch (err) {
      sendOrchestrationError(res, err);
    }
  })
);

// POST /api/applications/:id/answers/generate - generate answers for an
// application's questions (ownership-checked). Generates answers only: it never
// submits the application and never auto-approves answers.
router.post(
  '/:id/answers/generate',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;

    // `questionIds` is optional, but when present it must be an array of
    // strings. Anything else (e.g. a bare string) must NOT silently fall back
    // to regenerating every question on the application.
    const rawQuestionIds = req.body?.questionIds;
    if (
      rawQuestionIds !== undefined &&
      (!Array.isArray(rawQuestionIds) ||
        rawQuestionIds.some((qid) => typeof qid !== 'string'))
    ) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'questionIds must be an array of question IDs',
        },
      });
    }
    const questionIds = rawQuestionIds as string[] | undefined;

    try {
      const result = await generateApplicationAnswers({
        applicationId: id,
        userId,
        questionIds,
      });
      res.json({ data: result });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('APPLICATION_NOT_FOUND')) {
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Application not found' },
        });
      }
      // Phase 15D: content mutations are state-guarded (in-flight/submitted
      // content is locked; changing approved content invalidates the
      // approval) - report those honestly instead of a generic 500.
      sendOrchestrationError(res, err);
    }
  })
);

// POST /api/applications/:id/answers/generate/:questionId - generate an answer
// for a single question (ownership-checked, question must belong to the app).
router.post(
  '/:id/answers/generate/:questionId',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id, questionId } = req.params;

    const application = await prisma.application.findUnique({ where: { id } });
    if (!application || application.userId !== userId) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Application not found' },
      });
    }
    const question = await prisma.applicationQuestion.findFirst({
      where: { id: questionId, applicationId: id },
    });
    if (!question) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Question not found' },
      });
    }

    try {
      const result = await generateApplicationAnswers({
        applicationId: id,
        userId,
        questionIds: [questionId],
      });
      res.json({ data: result });
    } catch (err) {
      // Phase 15D: same state guards and honest reporting as the bulk route.
      sendOrchestrationError(res, err);
    }
  })
);

export default router;
