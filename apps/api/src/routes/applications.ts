import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { ApplicationStatus } from '@prisma/client';
import { paginationSchema, applicationStatusEnum } from '@jaa/shared';
import { generateApplicationAnswers } from '@jaa/core';
import { asyncHandler } from '../middleware/auth';

const router = Router();

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

    res.json({
      data: applications,
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

    res.json({ data: application });
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
      throw err;
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

    const result = await generateApplicationAnswers({
      applicationId: id,
      userId,
      questionIds: [questionId],
    });
    res.json({ data: result });
  })
);

export default router;
