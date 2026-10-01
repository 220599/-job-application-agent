import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { paginationSchema, jobCreateSchema } from '@jaa/shared';
import { asyncHandler } from '../middleware/auth';
import { ingestJobFromUrl } from '../services/job-ingestion';
import {
  calculateJobMatch,
  getJobMatch,
  listJobMatches,
  MatchServiceError,
} from '../services/job-matching';

const router = Router();

const ingestSchema = jobCreateSchema.pick({ url: true });

const MATCH_ERROR_STATUS: Record<string, number> = {
  JOB_NOT_FOUND: 404,
  PROFILE_NOT_FOUND: 400,
  MATCH_NOT_FOUND: 404,
};

function respondMatchError(res: Response, error: unknown): void {
  if (error instanceof MatchServiceError) {
    res.status(MATCH_ERROR_STATUS[error.code] ?? 500).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }
  throw error;
}

// POST /api/jobs - Ingest job from URL
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { url } = ingestSchema.parse(req.body);
    console.log('[API] Ingesting job from URL:', url, 'for user:', userId);

    try {
      const result = await ingestJobFromUrl(url, userId);
      console.log('[API] Ingestion result:', result.created ? 'created' : 'existing', result.job.id);
      
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
    console.log('[API] Ingestion completed successfully');
  })
);

// GET /api/jobs - List jobs (optionally sorted by match score)
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { page, pageSize } = paginationSchema.parse(req.query);
    const sortBy = req.query.sortBy === 'matchScore' ? 'matchScore' : 'discoveredAt';

    if (sortBy === 'matchScore') {
      // Sort by the user's best match score; jobs without a match go last.
      const jobs = await prisma.job.findMany({
        where: { userId },
        include: { jobMatches: { where: { userId } } },
        orderBy: { discoveredAt: 'desc' },
        take: 500,
      });
      jobs.sort((a, b) => {
        const aScore = a.jobMatches[0]?.score ?? -1;
        const bScore = b.jobMatches[0]?.score ?? -1;
        return bScore - aScore;
      });
      const total = jobs.length;
      const paged = jobs.slice((page - 1) * pageSize, page * pageSize);
      return res.json({
        data: paged,
        pagination: { page, pageSize, total },
      });
    }

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

// GET /api/jobs/matches - The user's matches ordered by score (registered before /:id)
router.get(
  '/matches',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const matches = await listJobMatches(userId);
    res.json({ data: matches });
  })
);

// POST /api/jobs/:jobId/match - Calculate or recalculate the match for the current user
router.post(
  '/:jobId/match',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    try {
      const match = await calculateJobMatch(userId, req.params.jobId);
      res.status(201).json({
        data: match,
        message: 'Match calculated',
      });
    } catch (error) {
      respondMatchError(res, error);
    }
  })
);

// GET /api/jobs/:jobId/match - Detailed stored match for one job
router.get(
  '/:jobId/match',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    try {
      const match = await getJobMatch(userId, req.params.jobId);
      res.json({ data: match });
    } catch (error) {
      respondMatchError(res, error);
    }
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
