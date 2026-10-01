import { prisma } from '@jaa/database';
import { Resume, ResumeVersion } from '@jaa/database';
import { parseAndImportResume } from './resume-parse';
import { Readable } from 'stream';
import * as fs from 'fs/promises';
import * as path from 'path';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'resumes');

async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

function validateFile(file: Express.Multer.File): { valid: boolean; error?: string } {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return { valid: false, error: 'Only PDF and DOCX files are allowed' };
  }
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: 'File size must be less than 10 MB' };
  }
  return { valid: true };
}

async function saveFile(file: Express.Multer.File, userId: string): Promise<string> {
  await ensureUploadDir();
  
  const ext = file.mimetype === 'application/pdf' ? 'pdf' : 'docx';
  const timestamp = Date.now();
  const filename = `${userId}-${timestamp}.${ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);
  
  await fs.writeFile(filePath, file.buffer);
  
  return filePath;
}

export interface UploadResult {
  resume: Resume;
  version: ResumeVersion;
  created: boolean;
  parsed?: unknown;
  importSummary?: unknown;
}

export async function uploadResume(
  userId: string,
  file: Express.Multer.File,
  name: string
): Promise<UploadResult> {
  const validation = validateFile(file);
  if (!validation.valid) {
    throw new Error(`VALIDATION_ERROR: ${validation.error}`);
  }

  // Check if this is the first resume for the user
  const existingResumesCount = await prisma.resume.count({
    where: { userId },
  });
  
  const isFirstResume = existingResumesCount === 0;

  // If this is set as default, unset any existing default
  if (isFirstResume) {
    await prisma.resume.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    });
  }

  const storageKey = await saveFile(file, userId);

  // Create the resume record
  const resume = await prisma.resume.create({
    data: {
      userId,
      name,
      originalFileName: file.originalname,
      fileType: file.mimetype === 'application/pdf' ? 'pdf' : 'docx',
      storageKey,
      fileSize: file.size,
      mimeType: file.mimetype,
      isDefault: isFirstResume,
    },
  });

  // Create the initial version
  const version = await prisma.resumeVersion.create({
    data: {
      resumeId: resume.id,
      versionNumber: 1,
      filePath: storageKey,
      source: 'ORIGINAL',
    },
  });

  // Parse the resume and import into the profile (fill-empty-only).
  // Parsing failures must never fail the upload itself.
  let parsed: unknown = null;
  let importSummary: unknown = null;
  try {
    const result = await parseAndImportResume(userId, resume.id);
    parsed = result.parsed;
    importSummary = result.importResult;
  } catch (err) {
    console.error('[RESUME PARSE] failed for resume', resume.id, err);
  }

  return { resume, version, created: true, parsed, importSummary };
}

export async function setDefaultResume(userId: string, resumeId: string): Promise<Resume> {
  // Verify ownership
  const resume = await prisma.resume.findUnique({
    where: { id: resumeId },
  });

  if (!resume || resume.userId !== userId) {
    throw new Error('RESUME_NOT_FOUND: Resume not found');
  }

  // Unset all defaults for this user
  await prisma.resume.updateMany({
    where: { userId, isDefault: true },
    data: { isDefault: false },
  });

  // Set the new default
  const updated = await prisma.resume.update({
    where: { id: resumeId },
    data: { isDefault: true },
  });

  return updated;
}

export async function deleteResume(userId: string, resumeId: string): Promise<void> {
  const resume = await prisma.resume.findUnique({
    where: { id: resumeId },
    include: { versions: true },
  });

  if (!resume || resume.userId !== userId) {
    throw new Error('RESUME_NOT_FOUND: Resume not found');
  }

  // Delete files from storage
  for (const version of resume.versions) {
    try {
      await fs.unlink(version.filePath);
    } catch {
      // Ignore file not found errors
    }
  }

  // Try to delete the original file
  try {
    await fs.unlink(resume.storageKey);
  } catch {
    // Ignore
  }

  // Delete from database (cascade will handle versions)
  await prisma.resume.delete({
    where: { id: resumeId },
  });
}