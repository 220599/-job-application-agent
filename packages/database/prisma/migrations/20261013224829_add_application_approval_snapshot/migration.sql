-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "approvalSnapshot" JSONB,
ADD COLUMN     "approvedAt" TIMESTAMP(3);
