import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { paginationSchema, jobCreateSchema } from '@jaa/shared';
import { asyncHandler } from '../middleware/auth';
import { ingestJobFromUrl } from '../services/job-ingestion';

const router = Router();

const ingestSchema = jobCreateSchema.pick({ url: true });

// POST /api/jobs - Ingest job from URL
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { url } = ingestSchema.parse(req.body);

    try {
      const result = await ingestJobFromUrl(url, userId);
      
      const statusCode = result.created ? 201 : 200;
      res.status(statusCode).json({ 
        data: result.job,
        message: result.created ? 'Job imported successfully' : 'Job already exists',
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.startsWith('FETCH_FAILED:')) {
          return res.status(502).json({
            error: {
              code: 'FETCH_FAILED',
              message: 'Could not fetch the job page',
              details: error.message.replace('FETCH_FAILED: ', ''),
            },
          });
        }
        if (error.message.startsWith('EXTRACTION_FAILED:')) {
          return res.status(422).json({
            error: {
              code: 'EXTRACTION_FAILED',
              message: 'Could not extract job information from the page',
              details: error.message.replace('EXTRACTION_FAILED: ', ''),
            },
          });
        }
        if (error.message.includes('Invalid URL') || error.message.includes('blocked') || error.message.includes('private')) {
          return res.status(400).json({
            error: {
              code: 'INVALID_URL',
              message: error.message,
            },
          });
        }
      }
      throw error;
    }
  })
);

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
