import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { educationCreateSchema, educationUpdateSchema } from '@jaa/shared';
import { asyncHandler } from '../middleware/auth';
import logger from '../logger';

const router = Router({ mergeParams: true });

// GET /api/candidate/education - List education
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

    const education = await prisma.education.findMany({
      where: { candidateProfileId: profile.id },
      orderBy: { startDate: 'desc' },
    });

    res.json({ data: education });
  })
);

// POST /api/candidate/education - Create education
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const data = educationCreateSchema.parse(req.body);

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

    const education = await prisma.education.create({
      data: {
        candidateProfileId: profile.id,
        ...data,
      },
    });

    logger.info('Education created', {
      userId,
      educationId: education.id,
    });

    res.status(201).json({ data: education });
  })
);

// PATCH /api/candidate/education/:id - Update education
router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const { id } = req.params;
    const data = educationUpdateSchema.parse(req.body);

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

    const education = await prisma.education.findUnique({
      where: { id },
    });

    if (!education || education.candidateProfileId !== profile.id) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Education record not found',
        },
      });
    }

    const updated = await prisma.education.update({
      where: { id },
      data,
    });

    logger.info('Education updated', { userId, educationId: id });

    res.json({ data: updated });
  })
);

// DELETE /api/candidate/education/:id - Delete education
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

    const education = await prisma.education.findUnique({
      where: { id },
    });

    if (!education || education.candidateProfileId !== profile.id) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Education record not found',
        },
      });
    }

    await prisma.education.delete({
      where: { id },
    });

    logger.info('Education deleted', { userId, educationId: id });

    res.json({ data: { id } });
  })
);

export default router;
