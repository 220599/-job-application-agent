import { Router, Request, Response } from 'express';
import { prisma } from '@jaa/database';
import { skillCreateSchema } from '@jaa/shared';
import { asyncHandler } from '../middleware/auth';
import logger from '../logger';

const router = Router({ mergeParams: true });

// GET /api/candidate/skills - List skills
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

    const skills = await prisma.skill.findMany({
      where: { candidateProfileId: profile.id },
      orderBy: { name: 'asc' },
    });

    res.json({ data: skills });
  })
);

// POST /api/candidate/skills - Create skill
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.userId!;
    const data = skillCreateSchema.parse(req.body);

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

    // Check if skill already exists
    const existing = await prisma.skill.findUnique({
      where: {
        candidateProfileId_name: {
          candidateProfileId: profile.id,
          name: data.name,
        },
      },
    });

    if (existing) {
      return res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: 'Skill already exists',
        },
      });
    }

    const skill = await prisma.skill.create({
      data: {
        candidateProfileId: profile.id,
        ...data,
      },
    });

    logger.info('Skill created', {
      userId,
      skillId: skill.id,
      skillName: skill.name,
    });

    res.status(201).json({ data: skill });
  })
);

// DELETE /api/candidate/skills/:id - Delete skill
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

    const skill = await prisma.skill.findUnique({
      where: { id },
    });

    if (!skill || skill.candidateProfileId !== profile.id) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Skill not found',
        },
      });
    }

    await prisma.skill.delete({
      where: { id },
    });

    logger.info('Skill deleted', {
      userId,
      skillId: id,
      skillName: skill.name,
    });

    res.json({ data: { id } });
  })
);

export default router;
