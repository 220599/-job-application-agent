import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import {
  candidateProfileCreateSchema,
  candidateProfileUpdateSchema,
} from '@jaa/shared';
import { asyncHandler } from '../middleware/auth';
import logger from '../logger';

const router = Router();

// GET /api/candidate - Get candidate profile for current user
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const profile = await prisma.candidateProfile.findUnique({
      where: { userId },
      include: {
        education: true,
        experience: true,
        skills: true,
      },
    });

    if (!profile) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Candidate profile not found',
        },
      });
    }

    res.json({ data: profile });
  })
);

// POST /api/candidate - Create candidate profile
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const data = candidateProfileCreateSchema.parse(req.body);

    // Check if profile already exists
    const existing = await prisma.candidateProfile.findUnique({
      where: { userId },
    });

    if (existing) {
      return res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: 'Candidate profile already exists',
        },
      });
    }

    const profile = await prisma.candidateProfile.create({
      data: {
        userId,
        ...data,
      },
    });

    logger.info('Candidate profile created', {
      userId,
      profileId: profile.id,
    });

    res.status(201).json({ data: profile });
  })
);

// PATCH /api/candidate - Update candidate profile
router.patch(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const data = candidateProfileUpdateSchema.parse(req.body);

    const profile = await prisma.candidateProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Candidate profile not found',
        },
      });
    }

    const updated = await prisma.candidateProfile.update({
      where: { userId },
      data,
    });

    logger.info('Candidate profile updated', {
      userId,
      profileId: profile.id,
    });

    res.json({ data: updated });
  })
);

export default router;
