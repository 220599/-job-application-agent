import { createHash } from 'node:crypto';

/**
 * Phase 15D - approval integrity (snapshot binding).
 *
 * The explicit human approval action binds the EXACT application snapshot it
 * approved:
 *
 *   - the submission target (jobId + applicationUrl - the employer and job),
 *   - the resume version (identity AND content: file path, extracted text,
 *     tailoring provenance, parsed data),
 *   - every question and its approved answer text.
 *
 * The snapshot is a fingerprint (SHA-256 over canonical JSON) plus the bound
 * identifiers, stored on the Application row by `approveApplicationForSubmission`.
 * At submission time (the durable attempt claim - the last gate before any
 * request can leave the process) the fingerprint is recomputed and compared.
 * Any drift - a changed answer, a swapped or edited resume version, a changed
 * target - means the approval no longer covers what would be submitted, and
 * submission is refused until a NEW explicit approval is given.
 *
 * Nothing here stores answer text, resume text, or candidate PII: only
 * identifiers and hashes. A missing snapshot is treated exactly like drift
 * (fail closed) - a submission is never allowed on an unverified approval.
 */

export interface ApprovalSnapshotInput {
  jobId: string;
  applicationUrl: string | null;
  resumeVersion: {
    id: string;
    filePath: string | null;
    extractedText: string | null;
    tailoring: unknown;
    parsedData: unknown;
  } | null;
  questions: Array<{
    id: string;
    label: string;
    required: boolean;
    fieldType: string;
    externalFieldId: string | null;
    options: unknown;
    locator: unknown;
    answer: { answer: string | null } | null;
  }>;
}

export interface ApprovalSnapshot {
  version: 1;
  jobId: string;
  applicationUrl: string | null;
  resumeVersionId: string | null;
  /** Fingerprint of the resume version CONTENT (never the content itself). */
  resumeContentHash: string;
  /** Fingerprint of every question + its answer (never the text itself). */
  answersHash: string;
  /** Fingerprint of the whole snapshot - compared at submission time. */
  contentHash: string;
  boundAt: string;
}

/** Which bound component changed since the approval. */
export type ApprovalDrift = 'TARGET' | 'RESUME' | 'ANSWERS';

export type ApprovalSnapshotVerdict =
  | { ok: true; snapshot: ApprovalSnapshot }
  | { ok: false; reason: 'NOT_BOUND' | 'STALE'; drift: ApprovalDrift[] };

/** Stable JSON: object keys sorted so hashes are order-independent. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Compute the snapshot fingerprint for the CURRENT application content.
 * Pure: no database access, no side effects.
 */
export function computeApprovalSnapshot(input: ApprovalSnapshotInput): ApprovalSnapshot {
  const resume = input.resumeVersion;
  const resumeContentHash = sha256(
    canonicalJson({
      id: resume?.id ?? null,
      filePath: resume?.filePath ?? null,
      extractedText: resume?.extractedText ?? null,
      tailoring: resume?.tailoring ?? null,
      parsedData: resume?.parsedData ?? null,
    })
  );

  const answersHash = sha256(
    canonicalJson(
      [...input.questions]
        .map((question) => ({
          id: question.id,
          label: question.label,
          required: question.required,
          fieldType: question.fieldType,
          externalFieldId: question.externalFieldId,
          options: question.options ?? null,
          locator: question.locator ?? null,
          answer: question.answer?.answer ?? null,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    )
  );

  const contentHash = sha256(
    canonicalJson({
      version: 1,
      jobId: input.jobId,
      applicationUrl: input.applicationUrl,
      resumeContentHash,
      answersHash,
    })
  );

  return {
    version: 1,
    jobId: input.jobId,
    applicationUrl: input.applicationUrl,
    resumeVersionId: resume?.id ?? null,
    resumeContentHash,
    answersHash,
    contentHash,
    boundAt: new Date().toISOString(),
  };
}

/** Parse a stored snapshot (JSON column) defensively. */
export function approvalSnapshotOf(stored: unknown): ApprovalSnapshot | null {
  if (!stored || typeof stored !== 'object') return null;
  const value = stored as Record<string, unknown>;
  if (value['version'] !== 1) return null;
  if (typeof value['contentHash'] !== 'string' || value['contentHash'].length === 0) return null;
  return value as unknown as ApprovalSnapshot;
}

/**
 * Compare the stored approval snapshot with the current content.
 *
 * A missing/unparseable snapshot is `NOT_BOUND` (fail closed - a submission
 * never proceeds on an approval the server cannot verify). A mismatch is
 * `STALE`, with the changed components named so the UI can explain what the
 * user must re-approve (component names only - never content).
 */
export function verifyApprovalSnapshot(
  stored: unknown,
  current: ApprovalSnapshot
): ApprovalSnapshotVerdict {
  const snapshot = approvalSnapshotOf(stored);
  if (!snapshot) {
    return { ok: false, reason: 'NOT_BOUND', drift: [] };
  }
  if (snapshot.contentHash === current.contentHash) {
    return { ok: true, snapshot };
  }
  const drift: ApprovalDrift[] = [];
  if (
    snapshot.jobId !== current.jobId ||
    snapshot.applicationUrl !== current.applicationUrl
  ) {
    drift.push('TARGET');
  }
  if (
    snapshot.resumeVersionId !== current.resumeVersionId ||
    snapshot.resumeContentHash !== current.resumeContentHash
  ) {
    drift.push('RESUME');
  }
  if (snapshot.answersHash !== current.answersHash) {
    drift.push('ANSWERS');
  }
  return { ok: false, reason: 'STALE', drift };
}
