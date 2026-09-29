import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { ApplicationStatus } from '@prisma/client';
import { paginationSchema, applicationStatusEnum } from '@jaa/shared';
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

export default router;
