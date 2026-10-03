'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { resumeApi } from '@/lib/api';
import type {
  ReviewChangedSection,
  ReviewEducationEntry,
  ReviewExperienceEntry,
  ReviewResumeContent,
  ResumeReviewEdit,
  ResumeReviewView,
} from '@jaa/shared';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Badge,
  Skeleton,
  Textarea,
  Label,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui';

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'ORIGINAL':
      return 'Original';
    case 'TAILORED':
      return 'Tailored';
    case 'USER_EDITED':
      return 'Human Edited';
    case 'IMPORTED':
      return 'Imported';
    case 'AI_GENERATED':
      return 'AI Generated';
    default:
      return source;
  }
}

function sourceVariant(source: string): 'default' | 'secondary' | 'outline' {
  switch (source) {
    case 'TAILORED':
      return 'secondary';
    case 'USER_EDITED':
      return 'outline';
    default:
      return 'default';
  }
}

function reviewBadge(status: string) {
  switch (status) {
    case 'APPROVED':
      return <Badge variant="success">Approved</Badge>;
    case 'REJECTED':
      return <Badge variant="destructive">Rejected</Badge>;
    default:
      return <Badge variant="outline">Pending Review</Badge>;
  }
}

function Section({
  title,
  changed,
  children,
}: {
  title: string;
  changed: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-md border p-4 ${
        changed ? 'border-amber-500/60 bg-amber-500/5' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {changed && <Badge variant="outline">Changed</Badge>}
      </div>
      <div className="mt-2 space-y-2 text-sm">{children}</div>
    </div>
  );
}

function ExperienceList({ entries }: { entries: ReviewExperienceEntry[] }) {
  if (entries.length === 0) return <p className="text-muted-foreground">None</p>;
  return (
    <div className="space-y-3">
      {entries.map((entry, i) => (
        <div key={i}>
          <p className="font-medium">
            {entry.title} at {entry.company}
          </p>
          <p className="text-xs text-muted-foreground">
            {entry.startDate ?? '?'} - {entry.isCurrent ? 'Present' : entry.endDate ?? 'Present'}
          </p>
          {entry.bullets.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
              {entry.bullets.map((bullet, bi) => (
                <li key={bi}>{bullet}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function EducationList({ entries }: { entries: ReviewEducationEntry[] }) {
  if (entries.length === 0) return <p className="text-muted-foreground">None</p>;
  return (
    <div className="space-y-3">
      {entries.map((entry, i) => (
        <div key={i}>
          <p className="font-medium">
            {entry.degree}
            {entry.fieldOfStudy ? ` in ${entry.fieldOfStudy}` : ''}, {entry.institution}
          </p>
          {entry.details.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
              {entry.details.map((detail, di) => (
                <li key={di}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function ContentSections({
  content,
  changedSections,
}: {
  content: ReviewResumeContent;
  changedSections: ReviewChangedSection[];
}) {
  const changed = (section: ReviewChangedSection) => changedSections.includes(section);
  return (
    <div className="space-y-4">
      <Section title="Summary" changed={changed('summary')}>
        {content.summary ? <p className="text-muted-foreground">{content.summary}</p> : <p className="text-muted-foreground">None</p>}
      </Section>
      <Section title="Skills" changed={changed('skills')}>
        {content.skills.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {content.skills.map((skill, i) => (
              <Badge key={i} variant="secondary">
                {skill}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">None</p>
        )}
      </Section>
      <Section title="Experience" changed={changed('experience')}>
        <ExperienceList entries={content.experience} />
      </Section>
      <Section title="Education" changed={changed('education')}>
        <EducationList entries={content.education} />
      </Section>
    </div>
  );
}

export default function ResumeReviewPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const resumeId = params.id as string;
  const versionId = params.versionId as string;

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editSummary, setEditSummary] = useState('');
  const [editSkills, setEditSkills] = useState('');
  const [editBullets, setEditBullets] = useState<string[]>([]);
  const [editDetails, setEditDetails] = useState<string[]>([]);

  const {
    data: reviewData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['resume-review', resumeId, versionId],
    queryFn: () => resumeApi.getReview(resumeId, versionId),
    enabled: !!resumeId && !!versionId,
  });

  const view: ResumeReviewView | undefined = reviewData?.data;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['resume-review', resumeId, versionId] });
    queryClient.invalidateQueries({ queryKey: ['resumes'] });
  };

  const approveMutation = useMutation({
    mutationFn: () => resumeApi.approveReview(resumeId, versionId),
    onSuccess: (response) => {
      invalidate();
      setSuccessMessage(response.message);
      setErrorMessage(null);
    },
    onError: (err: any) => setErrorMessage(err?.message || 'Failed to approve resume'),
  });

  const rejectMutation = useMutation({
    mutationFn: () => resumeApi.rejectReview(resumeId, versionId, rejectNote),
    onSuccess: (response) => {
      invalidate();
      setSuccessMessage(response.message);
      setErrorMessage(null);
    },
    onError: (err: any) => setErrorMessage(err?.message || 'Failed to reject resume'),
  });

  const editMutation = useMutation({
    mutationFn: (content: ResumeReviewEdit) => resumeApi.editReview(resumeId, versionId, content),
    onSuccess: (response) => {
      setShowEditDialog(false);
      queryClient.invalidateQueries({ queryKey: ['resumes'] });
      setSuccessMessage(response.message);
      setErrorMessage(null);
      // The edited content is a NEW immutable version that starts PENDING;
      // open the review workspace for it.
      router.push(`/resumes/${resumeId}/versions/${response.data.version.id}/review`);
    },
    onError: (err: any) => {
      const violations = (err?.details ?? []) as Array<{ type?: string; path?: string }>;
      const detailText = violations
        .map((v) => `${v.path ?? ''}${v.path ? ': ' : ''}${v.type ?? 'UNSUPPORTED_FIELD'}`)
        .join(', ');
      setErrorMessage(
        detailText
          ? `Edit rejected - unsupported content (${detailText})`
          : err?.message || 'Failed to save edited resume'
      );
    },
  });

  const openEditDialog = () => {
    if (!view) return;
    setEditSummary(view.tailoredContent.summary ?? '');
    setEditSkills(view.tailoredContent.skills.join('\n'));
    setEditBullets(view.tailoredContent.experience.map((e) => e.bullets.join('\n')));
    setEditDetails(view.tailoredContent.education.map((e) => e.details.join('\n')));
    setShowEditDialog(true);
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!view) return;
    const lines = (value: string) =>
      value
        .split('\n')
        .map((line) => line.replace(/^-\s*/, '').trim())
        .filter((line) => line !== '');

    const content: ResumeReviewEdit = {
      ...(editSummary.trim() !== '' ? { summary: editSummary.trim() } : {}),
      skills: lines(editSkills),
      experience: view.tailoredContent.experience.map((entry, i) => ({
        company: entry.company,
        title: entry.title,
        bullets: lines(editBullets[i] ?? ''),
      })),
      education: view.tailoredContent.education.map((entry, i) => ({
        institution: entry.institution,
        degree: entry.degree,
        fieldOfStudy: entry.fieldOfStudy,
        ...(lines(editDetails[i] ?? '').length > 0 ? { details: lines(editDetails[i] ?? '') } : {}),
      })),
    };
    setErrorMessage(null);
    editMutation.mutate(content);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Link href="/resumes" className="text-sm text-primary hover:underline inline-block">
          &larr; Back to Resumes
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Resume Review</h1>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !view) {
    return (
      <div className="space-y-6">
        <Link href="/resumes" className="text-sm text-primary hover:underline inline-block">
          &larr; Back to Resumes
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Resume Review</h1>
        <div className="rounded-md bg-destructive/10 p-4 text-destructive">
          <p>This resume version is not available for review.</p>
          <Link href="/resumes" className="mt-2 inline-block text-primary hover:underline">
            Back to Resumes
          </Link>
        </div>
      </div>
    );
  }

  const isPending = view.review.reviewStatus === 'PENDING';
  const busy = approveMutation.isPending || rejectMutation.isPending || editMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/resumes" className="text-sm text-primary hover:underline mb-2 inline-block">
            &larr; Back to Resumes
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">Human Review</h1>
          <p className="text-muted-foreground">
            Compare the tailored resume with its source and approve or reject it before anything
            proceeds.
          </p>
        </div>
        {isPending && (
          <Button variant="outline" onClick={openEditDialog} disabled={busy}>
            Edit Tailored Content
          </Button>
        )}
      </div>

      {successMessage && (
        <div className="rounded-md bg-green-500/10 p-4 text-green-600 dark:bg-green-500/20">
          <p className="text-sm font-medium">{successMessage}</p>
        </div>
      )}
      {errorMessage && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive">
          <p className="text-sm font-medium">{errorMessage}</p>
        </div>
      )}

      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle className="truncate">{view.resume.name}</CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">v{view.version.versionNumber}</Badge>
            <Badge variant={sourceVariant(view.version.source)}>{sourceLabel(view.version.source)}</Badge>
            <Badge variant="success">Validation Passed</Badge>
            {reviewBadge(view.review.reviewStatus)}
            {view.version.changeSummary && <span>{view.version.changeSummary}</span>}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            <span className="font-medium">Target job:</span>{' '}
            {view.job ? `${view.job.title} at ${view.job.company}` : 'Job unavailable'}
            {view.job?.location ? ` (${view.job.location})` : ''}
          </p>
          <p>
            <span className="font-medium">Version created:</span> {formatDate(view.version.createdAt)}
          </p>
          {view.review.reviewStatus !== 'PENDING' && (
            <p>
              <span className="font-medium">
                {view.review.reviewStatus === 'APPROVED' ? 'Approved' : 'Rejected'}
              </span>{' '}
              on {formatDate(view.review.reviewedAt)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Provenance panel - safe metadata only (never prompts, secrets, or raw audit metadata) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tailoring Provenance</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Tailored for:</dt>
              <dd className="font-medium">
                {view.job ? `${view.job.title} at ${view.job.company}` : 'Job unavailable'}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Source version:</dt>
              <dd className="font-medium">v{view.sourceVersion.versionNumber}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Tailored version:</dt>
              <dd className="font-medium">v{view.version.versionNumber}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Strategy:</dt>
              <dd className="font-medium">{view.provenance.strategy}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">AI generated:</dt>
              <dd className="font-medium">{view.provenance.aiGenerated ? 'Yes' : 'No (human edit)'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Validation:</dt>
              <dd className="font-medium">
                {view.validationStatus === 'PASSED' ? 'Passed' : view.validationStatus}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Generated:</dt>
              <dd className="font-medium">{formatDate(view.provenance.generatedAt)}</dd>
            </div>
            {view.provenance.provider && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Provider:</dt>
                <dd className="font-medium">
                  {view.provenance.provider}
                  {view.provenance.model ? ` (${view.provenance.model})` : ''}
                </dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Source vs Tailored comparison */}
      <div>
        <h2 className="mb-3 text-lg font-semibold">Source vs Tailored</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Source Resume - v{view.sourceVersion.versionNumber}
              </CardTitle>
              <CardDescription>{sourceLabel(view.sourceVersion.source)}</CardDescription>
            </CardHeader>
            <CardContent>
              <ContentSections content={view.sourceContent} changedSections={view.changedSections} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Tailored Resume - v{view.version.versionNumber}
              </CardTitle>
              <CardDescription>{sourceLabel(view.version.source)}</CardDescription>
            </CardHeader>
            <CardContent>
              <ContentSections content={view.tailoredContent} changedSections={view.changedSections} />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Review actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Review Decision</CardTitle>
          <CardDescription>
            Approving marks this resume version as ready for later steps. It does not submit any
            application.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {view.review.reviewStatus === 'APPROVED' && (
            <div className="rounded-md bg-green-500/10 p-4 text-green-600 dark:bg-green-500/20">
              <p className="text-sm font-medium">
                Approved on {formatDate(view.review.reviewedAt)}
              </p>
            </div>
          )}
          {view.review.reviewStatus === 'REJECTED' && (
            <div className="rounded-md bg-destructive/10 p-4 text-destructive">
              <p className="text-sm font-medium">Rejected on {formatDate(view.review.reviewedAt)}</p>
              {view.review.reviewNotes && (
                <p className="mt-1 text-sm">Reason: {view.review.reviewNotes}</p>
              )}
            </div>
          )}

          {isPending && (
            <div className="grid gap-2">
              <Label htmlFor="reject-note">Rejection reason (optional)</Label>
              <Textarea
                id="reject-note"
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder="Why should this tailored resume not proceed?"
                maxLength={500}
                disabled={busy}
              />
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => {
                setSuccessMessage(null);
                setErrorMessage(null);
                approveMutation.mutate();
              }}
              disabled={!isPending || busy}
            >
              {approveMutation.isPending ? 'Approving...' : 'Approve Resume'}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setSuccessMessage(null);
                setErrorMessage(null);
                rejectMutation.mutate();
              }}
              disabled={!isPending || busy}
            >
              {rejectMutation.isPending ? 'Rejecting...' : 'Reject Resume'}
            </Button>
          </div>
          {!isPending && (
            <p className="text-xs text-muted-foreground">
              This version has already been reviewed. The decision is final for this version; edits
              create a new version.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Human edit dialog - edits create a NEW immutable version */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Tailored Content</DialogTitle>
            <DialogDescription>
              Your corrections are validated against your candidate facts and saved as a new
              immutable version. Unsupported claims cannot be added.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleEditSubmit} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-summary">Summary</Label>
              <Textarea
                id="edit-summary"
                value={editSummary}
                onChange={(e) => setEditSummary(e.target.value)}
                rows={4}
                disabled={editMutation.isPending}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="edit-skills">Skills (one per line)</Label>
              <Textarea
                id="edit-skills"
                value={editSkills}
                onChange={(e) => setEditSkills(e.target.value)}
                rows={4}
                disabled={editMutation.isPending}
              />
            </div>

            {view.tailoredContent.experience.map((entry, i) => (
              <div className="grid gap-2" key={`exp-${i}`}>
                <Label htmlFor={`edit-exp-${i}`}>
                  {entry.title} at {entry.company} (one bullet per line)
                </Label>
                <Textarea
                  id={`edit-exp-${i}`}
                  value={editBullets[i] ?? ''}
                  onChange={(e) =>
                    setEditBullets((prev) => {
                      const next = [...prev];
                      next[i] = e.target.value;
                      return next;
                    })
                  }
                  rows={4}
                  disabled={editMutation.isPending}
                />
              </div>
            ))}

            {view.tailoredContent.education.map((entry, i) => (
              <div className="grid gap-2" key={`edu-${i}`}>
                <Label htmlFor={`edit-edu-${i}`}>
                  {entry.degree}, {entry.institution} (details, one per line - optional)
                </Label>
                <Textarea
                  id={`edit-edu-${i}`}
                  value={editDetails[i] ?? ''}
                  onChange={(e) =>
                    setEditDetails((prev) => {
                      const next = [...prev];
                      next[i] = e.target.value;
                      return next;
                    })
                  }
                  rows={2}
                  disabled={editMutation.isPending}
                />
              </div>
            ))}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowEditDialog(false)}
                disabled={editMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={editMutation.isPending}>
                {editMutation.isPending ? 'Saving...' : 'Save as New Version'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
