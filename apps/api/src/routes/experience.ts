import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { experienceCreateSchema, experienceUpdateSchema } from '@jaa/shared';
import { asyncHandler } from '../middleware/auth';
import logger from '../logger';

const router = Router({ mergeParams: true });

// GET /api/candidate/experience - List experience
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;

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

    const experience = await prisma.experience.findMany({
      where: { candidateProfileId: profile.id },
      orderBy: { startDate: 'desc' },
    });

    res.json({ data: experience });
  })
);

// POST /api/candidate/experience - Create experience
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const data = experienceCreateSchema.parse(req.body);

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

    const experience = await prisma.experience.create({
      data: {
        candidateProfileId: profile.id,
        ...data,
      },
    });

    logger.info('Experience created', {
      userId,
      experienceId: experience.id,
    });

    res.status(201).json({ data: experience });
  })
);

// PATCH /api/candidate/experience/:id - Update experience
router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;
    const data = experienceUpdateSchema.parse(req.body);

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

    const experience = await prisma.experience.findUnique({
      where: { id },
    });

    if (!experience || experience.candidateProfileId !== profile.id) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Experience record not found',
        },
      });
    }

    const updated = await prisma.experience.update({
      where: { id },
      data,
    });

    logger.info('Experience updated', { userId, experienceId: id });

    res.json({ data: updated });
  })
);

// DELETE /api/candidate/experience/:id - Delete experience
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;

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

    const experience = await prisma.experience.findUnique({
      where: { id },
    });

    if (!experience || experience.candidateProfileId !== profile.id) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Experience record not found',
        },
      });
    }

    await prisma.experience.delete({
      where: { id },
    });

    logger.info('Experience deleted', { userId, experienceId: id });

    res.json({ data: { id } });
  })
);

export default router;
