import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { paginationSchema } from '@jaa/shared';
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