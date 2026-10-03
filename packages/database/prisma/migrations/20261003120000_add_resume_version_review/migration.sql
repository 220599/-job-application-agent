-- Phase 12: Human Review Workspace
-- Smallest additive change: human review state on ResumeVersion plus two
-- audit event types for resume approval/rejection. Existing rows default to
-- PENDING; no data is rewritten and no unrelated tables are touched.

CREATE TYPE "ResumeReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "ResumeVersion"
ADD COLUMN "reviewStatus" "ResumeReviewStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewedBy" TEXT,
ADD COLUMN "reviewNotes" TEXT;

-- Enum additions last (PostgreSQL requires the new values to be unused in the
-- same transaction that adds them).
ALTER TYPE "ApplicationEventType" ADD VALUE 'RESUME_APPROVED';
ALTER TYPE "ApplicationEventType" ADD VALUE 'RESUME_REJECTED';
