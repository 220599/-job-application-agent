import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { paginationSchema } from '@jaa/shared';
import { asyncHandler } from '../middleware/auth';

const router = Router();

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

export default router;
