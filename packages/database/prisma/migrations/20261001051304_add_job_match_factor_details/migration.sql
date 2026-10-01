-- AlterTable
ALTER TABLE "JobMatch" ADD COLUMN     "matchedCriteria" JSONB,
ADD COLUMN     "matchedSkills" JSONB,
ADD COLUMN     "missingSkills" JSONB,
ADD COLUMN     "salaryScore" INTEGER;
