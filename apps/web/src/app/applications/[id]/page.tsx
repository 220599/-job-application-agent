'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  applicationsApi,
  type ApplicationDetail,
  type ApplicationQuestionView,
} from '@/lib/api';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Badge,
  Skeleton,
} from '@/components/ui';
import { StatusBadge } from '@/components/submission-status-badge';
import { ExternalLink, Loader2, ArrowLeft } from 'lucide-react';
import Link from 'next/link';

// The review surface for one application: the EXACT content the approval will
// bind (target, resume version, every question and answer) plus the honest,
// server-derived status. Approval and submission are explicit actions here -
// nothing is ever inferred, and nothing is ever claimed as submitted without
// the persisted provider evidence the API reports.
export default function ApplicationReviewPage({
  params,
}: {
  params: { id: string };
}) {
  const applicationId = params.id as string;

  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const {
    data: applicationData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['application', applicationId],
    queryFn: () => applicationsApi.get(applicationId),
    enabled: !!applicationId,
  });

  const application: ApplicationDetail | undefined = applicationData?.data;
  const status = application?.submissionStatus ?? null;
  const phase = status?.phase;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['application', applicationId] });
    queryClient.invalidateQueries({ queryKey: ['applications'] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
  };

  const approveMutation = useMutation({
    mutationFn: () => applicationsApi.approve(applicationId),
    onSuccess: () => {
      setErrorMessage(null);
      setInfoMessage('Application snapshot approved. You can now submit it.');
      invalidate();
    },
    onError: (err: any) => {
      setInfoMessage(null);
      setErrorMessage(err?.message || 'Approval failed');
    },
  });

  const submitMutation = useMutation({
    mutationFn: () => applicationsApi.submit(applicationId),
    onSuccess: () => {
      setErrorMessage(null);
      // Queued is not success: the badge keeps reporting the persisted status
      // (Processing until the worker records the real outcome).
      setInfoMessage('Submission queued for processing. This is not a confirmation yet.');
      invalidate();
    },
    onError: (err: any) => {
      setInfoMessage(null);
      setErrorMessage(err?.message || 'Submission could not be queued');
    },
  });

  const acting = approveMutation.isPending || submitMutation.isPending;

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-4xl">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error || !application) {
    return (
      <div className="space-y-6 max-w-4xl">
        <Link href="/applications" className="flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to applications
        </Link>
        <div className="rounded-md bg-destructive/10 p-4 text-destructive">
          <p>This application could not be loaded. Please refresh and try again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <Link
        href="/applications"
        className="flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> Back to applications
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {application.job?.title ?? 'Application'}
          </h1>
          <p className="text-muted-foreground">
            {application.job?.company ?? 'Unknown company'}
            {application.job?.location ? ` · ${application.job.location}` : ''}
            {application.job?.ats ? ` · ${application.job.ats}` : ''}
          </p>
        </div>
        <StatusBadge status={status} />
      </div>

      {errorMessage ? (
        <Card className="border-destructive">
          <CardContent className="py-4 text-sm text-destructive">{errorMessage}</CardContent>
        </Card>
      ) : null}
      {infoMessage ? (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">{infoMessage}</CardContent>
        </Card>
      ) : null}

      {/* Status + actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {status ? <p className="text-sm text-muted-foreground">{status.guidance}</p> : null}

          {application.errorCode && phase !== 'OUTCOME_UNKNOWN' ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Reason:</span>{' '}
              {application.errorCode}
              {application.errorMessage ? ` - ${application.errorMessage}` : ''}
            </p>
          ) : null}

          {application.externalApplicationId ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Provider reference:</span>{' '}
              {application.externalApplicationId}
            </p>
          ) : null}

          {application.submittedAt ? (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Submitted:</span>{' '}
              {new Date(application.submittedAt).toLocaleString()}
            </p>
          ) : null}

          {status?.requiresHumanResolution ? (
            <p className="text-sm font-medium text-destructive">
              This application needs your manual resolution before anything else can happen.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {application.applicationUrl ? (
              <a
                href={application.applicationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                Open application <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null}
            {phase === 'AWAITING_APPROVAL' ? (
              <Button
                size="sm"
                onClick={() => approveMutation.mutate()}
                disabled={acting}
              >
                {approveMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'Approve for submission'
                )}
              </Button>
            ) : null}
            {phase === 'APPROVED' ? (
              <Button size="sm" onClick={() => submitMutation.mutate()} disabled={acting}>
                {submitMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'Submit'
                )}
              </Button>
            ) : null}
            {!status?.safeToRetry && phase !== 'SUBMITTED' ? (
              <span className="text-xs text-muted-foreground">
                No automatic resubmission will occur.
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* The exact application content the approval binds */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Application content</CardTitle>
          <CardDescription>
            The approval binds exactly this content - any later change requires a new
            approval.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Resume:</span>{' '}
            {application.resumeVersion
              ? `version ${application.resumeVersion.versionNumber} (review: ${
                  application.resumeVersion.reviewStatus ?? 'unreviewed'
                })`
              : 'none attached'}
          </p>
          {application.questions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No application questions have been discovered yet. Start preparation to
              inspect the application form.
            </p>
          ) : (
            application.questions.map((question: ApplicationQuestionView) => (
              <div key={question.id} className="rounded-md border p-3 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{question.label}</p>
                  <div className="flex items-center gap-1">
                    {question.required ? (
                      <Badge variant="outline">Required</Badge>
                    ) : null}
                    {question.answer?.needsReview ? (
                      <Badge variant="warning">Needs review</Badge>
                    ) : null}
                  </div>
                </div>
                <p className="text-sm text-muted-foreground whitespace-pre-line">
                  {question.answer?.answer ?? 'Not answered yet'}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Persisted event timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Timeline</CardTitle>
          <CardDescription>Recorded events from the persisted application log</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {application.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded yet.</p>
          ) : (
            application.events.map((event) => (
              <div key={event.id} className="flex items-start gap-2 text-sm">
                <span className="text-muted-foreground whitespace-nowrap">
                  {new Date(event.createdAt).toLocaleString()}
                </span>
                <span>
                  <span className="font-medium">{event.eventType}</span>
                  {event.status ? ` · ${event.status}` : ''}
                  {event.message ? ` - ${event.message}` : ''}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
