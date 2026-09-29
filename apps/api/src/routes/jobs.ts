import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { paginationSchema } from '@jaa/shared';
import { asyncHandler } from '../middleware/auth';

const router = Router();

// GET /api/jobs - List jobs
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { page, pageSize } = paginationSchema.parse(req.query);

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where: { userId },
        include: {
          jobMatches: {
            where: { userId },
          },
        },
        orderBy: { discoveredAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.job.count({
        where: { userId },
      }),
    ]);

    res.json({
      data: jobs,
      pagination: {
        page,
        pageSize,
        total,
      },
    });
  })
);

// GET /api/jobs/:id - Get job details
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;

    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        jobMatches: {
          where: { userId },
        },
      },
    });

    if (!job || job.userId !== userId) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Job not found',
        },
      });
    }

    res.json({ data: job });
  })
);

export default router;
