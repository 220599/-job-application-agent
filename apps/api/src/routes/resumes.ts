import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import {
  paginationSchema,
  resumeTailorSchema,
  resumeReviewEditSchema,
  resumeReviewRejectSchema,
} from '@jaa/shared';
import {
  tailorResumeVersion,
  ResumeTailoringError,
  loadReviewView,
  approveResumeVersion,
  rejectResumeVersion,
  createHumanEditedVersion,
  ResumeReviewError,
} from '@jaa/core';
import { asyncHandler } from '../middleware/auth';
import multer from 'multer';
import { uploadResume, setDefaultResume, deleteResume } from '../services/resume-upload';
import {
  parseAndImportResume,
  parseResumeText,
  extractResumeText,
  type ParsedProfile,
} from '../services/resume-parse';

const router = Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and DOCX files are allowed'));
    }
  },
});

// GET /api/resumes - List resumes
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { page, pageSize } = paginationSchema.parse(req.query);

    const [resumes, total] = await Promise.all([
      prisma.resume.findMany({
        where: { userId },
        include: {
          versions: {
            orderBy: { versionNumber: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.resume.count({
        where: { userId },
      }),
    ]);

    res.json({
      data: resumes,
      pagination: {
        page,
        pageSize,
        total,
      },
    });
  })
);

// GET /api/resumes/:id - Get resume details
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;

    const resume = await prisma.resume.findUnique({
      where: { id },
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
        },
      },
    });

    if (!resume || resume.userId !== userId) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Resume not found',
        },
      });
    }

    res.json({ data: resume });
  })
);

// POST /api/resumes - Upload resume
router.post(
  '/',
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'name', maxCount: 1 }]),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const file = files?.file?.[0];
    const name = req.body.name || files?.name?.[0]?.toString();

    if (!file) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'File is required',
        },
      });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Resume name is required',
        },
      });
    }

    try {
      const result = await uploadResume(userId, file, name.trim());

      res.status(result.created ? 201 : 200).json({
        data: result.resume,
        message: result.created ? 'Resume uploaded successfully' : 'Resume already exists',
        importSummary: result.importSummary ?? null,
        parsed: result.parsed ?? null,
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.startsWith('VALIDATION_ERROR:')) {
          return res.status(400).json({
            error: {
              code: 'VALIDATION_ERROR',
              message: error.message.replace('VALIDATION_ERROR: ', ''),
            },
          });
        }
        if (error.message.startsWith('FILE_TOO_LARGE:')) {
          return res.status(413).json({
            error: {
              code: 'FILE_TOO_LARGE',
              message: 'File size exceeds 10 MB limit',
            },
          });
        }
        if (error.message.includes('Only PDF and DOCX')) {
          return res.status(415).json({
            error: {
              code: 'INVALID_FILE_TYPE',
              message: 'Only PDF and DOCX files are allowed',
            },
          });
        }
      }
      throw error;
    }
  })
);

// POST /api/resumes/:id/reimport - Re-run parse + profile import for an existing resume
router.post(
  '/:id/reimport',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;

    try {
      const resume = await prisma.resume.findUnique({ where: { id } });
      if (!resume || resume.userId !== userId) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resume not found' } });
      }
      const { parsed, importResult } = await parseAndImportResume(userId, id);
      res.json({ data: { parsed, importResult }, message: 'Profile updated from resume' });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('RESUME')) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: error.message } });
      }
      throw error;
    }
  })
);

// GET /api/resumes/:id/extracted - Preview parsed resume data without importing
router.get(
  '/:id/extracted',
  (asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;

    const resume = await prisma.resume.findUnique({
      where: { id },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!resume || resume.userId !== userId) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resume not found' } });
    }

    const version = resume.versions[0];
    let parsed: ParsedProfile | null = null;
    if (version?.parsedData) {
      parsed = version.parsedData as unknown as ParsedProfile;
    } else if (version) {
      const buffer = await import('fs/promises').then((fs) => fs.readFile(version.filePath));
      const text = await extractResumeText(buffer, resume.mimeType);
      parsed = parseResumeText(text);
      await prisma.resumeVersion.update({
        where: { id: version.id },
        data: { extractedText: text, parsedData: parsed as any },
      });
    }

    res.json({ data: { parsed } });
  }) as any)
);

// Auth guard for the tailoring/version endpoints: they require an
// authenticated user even if the global middleware were bypassed.
function requireUser(req: Request, res: Response): string | null {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    return null;
  }
  return userId;
}

// GET /api/resumes/:id/versions - List all versions of a resume (ownership-checked)
router.get(
  '/:id/versions',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { id } = req.params;

    const resume = await prisma.resume.findUnique({
      where: { id },
      include: { versions: { orderBy: { versionNumber: 'desc' } } },
    });
    if (!resume || resume.userId !== userId) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resume not found' } });
    }

    res.json({ data: resume.versions });
  })
);

// GET /api/resumes/:id/versions/:versionId - Get one resume version
router.get(
  '/:id/versions/:versionId',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { id, versionId } = req.params;

    const resume = await prisma.resume.findUnique({ where: { id } });
    if (!resume || resume.userId !== userId) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resume not found' } });
    }
    const version = await prisma.resumeVersion.findFirst({
      where: { id: versionId, resumeId: id },
    });
    if (!version) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Version not found' } });
    }

    res.json({ data: version });
  })
);

// POST /api/resumes/:id/versions/:versionId/tailor - tailor a resume version
// toward a Job. Creates a NEW immutable ResumeVersion (source = TAILORED);
// the source version is never modified. AI failure or fabricated content
// (validation failure) creates NO version and returns a structured error.
const TAILORING_ERROR_STATUS: Record<string, number> = {
  RESUME_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  EMPTY_RESUME_CONTENT: 422,
  VALIDATION_FAILED: 422,
  MODEL_REQUESTED_REVIEW: 422,
  AI_PROVIDER_UNAVAILABLE: 503,
  AI_RATE_LIMITED: 503,
  AI_TIMEOUT: 504,
  AI_EMPTY_RESPONSE: 502,
  AI_INVALID_RESPONSE: 502,
  AI_REQUEST_FAILED: 502,
};

router.post(
  '/:id/versions/:versionId/tailor',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { id, versionId } = req.params;
    const { jobId, regenerate } = resumeTailorSchema.parse(req.body);

    try {
      const result = await tailorResumeVersion({
        resumeId: id,
        versionId,
        jobId,
        userId,
        regenerate,
      });
      res.status(result.reused ? 200 : 201).json({
        data: result,
        message: result.reused
          ? 'Existing tailored resume version reused'
          : 'Resume tailored successfully',
      });
    } catch (err) {
      if (err instanceof ResumeTailoringError) {
        return res.status(TAILORING_ERROR_STATUS[err.code] ?? 500).json({
          error: {
            code: err.code,
            message: err.message,
            ...(err.violations.length > 0 ? { details: err.violations } : {}),
          },
        });
      }
      throw err;
    }
  })
);

// ---------------------------------------------------------------------------
// Phase 12 - Human Review Workspace.
//
// Review is the safety boundary between AI tailoring and any later automation:
// a tailored version can only proceed after a human approves it. Approving a
// resume is NOT application approval - Application.status is never changed
// here and nothing is submitted.
// ---------------------------------------------------------------------------

const REVIEW_ERROR_STATUS: Record<string, number> = {
  RESUME_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  NOT_REVIEWABLE: 422,
  REVIEW_CONFLICT: 409,
  VALIDATION_FAILED: 422,
};

function handleReviewError(err: unknown, res: Response): boolean {
  if (err instanceof ResumeReviewError) {
    res.status(REVIEW_ERROR_STATUS[err.code] ?? 500).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.violations.length > 0 ? { details: err.violations } : {}),
      },
    });
    return true;
  }
  return false;
}

// GET /api/resumes/:id/versions/:versionId/review - review workspace payload:
// source version, tailored version, job info, safe tailoring metadata,
// validation status, review status, version information. Never prompts,
// provider secrets, storage paths, or raw audit metadata.
router.get(
  '/:id/versions/:versionId/review',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { id, versionId } = req.params;

    try {
      const view = await loadReviewView({ resumeId: id, versionId, userId });
      res.json({ data: view });
    } catch (err) {
      if (!handleReviewError(err, res)) throw err;
    }
  })
);

// POST /api/resumes/:id/versions/:versionId/review/approve - approve a
// tailored resume version (idempotent; atomic PENDING -> APPROVED).
router.post(
  '/:id/versions/:versionId/review/approve',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { id, versionId } = req.params;

    try {
      const result = await approveResumeVersion({ resumeId: id, versionId, userId });
      res.json({
        data: result,
        message: result.changed ? 'Resume approved' : 'Resume was already approved',
      });
    } catch (err) {
      if (!handleReviewError(err, res)) throw err;
    }
  })
);

// POST /api/resumes/:id/versions/:versionId/review/reject - reject a tailored
// resume version with an optional short note (idempotent; the version is kept).
router.post(
  '/:id/versions/:versionId/review/reject',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { id, versionId } = req.params;
    const { note } = resumeReviewRejectSchema.parse(req.body ?? {});

    try {
      const result = await rejectResumeVersion({
        resumeId: id,
        versionId,
        userId,
        note: note ?? null,
      });
      res.json({
        data: result,
        message: result.changed ? 'Resume rejected' : 'Resume was already rejected',
      });
    } catch (err) {
      if (!handleReviewError(err, res)) throw err;
    }
  })
);

// POST /api/resumes/:id/versions/:versionId/review/edit - human corrections of
// tailored content. Creates a NEW immutable version (USER_EDITED, review state
// PENDING); the edited version and its source are never modified. Edited
// content must pass the Phase 11 anti-fabrication validator.
router.post(
  '/:id/versions/:versionId/review/edit',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { id, versionId } = req.params;
    const content = resumeReviewEditSchema.parse(req.body ?? {});

    try {
      const result = await createHumanEditedVersion({
        resumeId: id,
        versionId,
        userId,
        content,
      });
      res.status(201).json({
        data: result,
        message: 'Human-edited resume version created',
      });
    } catch (err) {
      if (!handleReviewError(err, res)) throw err;
    }
  })
);

// PATCH /api/resumes/:id/set-default - Set default resume
router.patch(
  '/:id/set-default',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;

    try {
      const resume = await setDefaultResume(userId, id);
      res.json({ data: resume, message: 'Default resume updated' });
    } catch (error) {
      if (error instanceof Error && error.message === 'RESUME_NOT_FOUND: Resume not found') {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Resume not found',
          },
        });
      }
      throw error;
    }
  })
);

// DELETE /api/resumes/:id - Delete resume
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;

    try {
      await deleteResume(userId, id);
      res.json({ data: { id }, message: 'Resume deleted successfully' });
    } catch (error) {
      if (error instanceof Error && error.message === 'RESUME_NOT_FOUND: Resume not found') {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Resume not found',
          },
        });
      }
      throw error;
    }
  })
);

export default router;