'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  applicationsApi,
  type ApplicationSummary,
  type SubmissionStatusView,
} from '@/lib/api';
import { StatusBadge } from '@/components/submission-status-badge';
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
import { FolderKanban, Plus, Briefcase, ExternalLink, Loader2 } from 'lucide-react';
import Link from 'next/link';

// Status presentation is shared (lib/submission-phases + StatusBadge) so every
// surface reports the same honest, server-derived phases.

function ApplicationCard({
  application,
  onApprove,
  onSubmit,
  acting,
}: {
  application: ApplicationSummary;
  onApprove: (id: string) => void;
  onSubmit: (id: string) => void;
  acting: boolean;
}) {
  const status = application.submissionStatus;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">
              {application.job?.title ?? 'Application'}
              {application.job?.company ? (
                <span className="font-normal text-muted-foreground"> · {application.job.company}</span>
              ) : null}
            </CardTitle>
            <CardDescription>
              {application.job?.ats ?? 'ATS'}
              {application.submittedAt
                ? ` · submitted ${new Date(application.submittedAt).toLocaleDateString()}`
                : ''}
            </CardDescription>
          </div>
          <StatusBadge status={status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {status ? (
          <p className="text-sm text-muted-foreground">{status.guidance}</p>
        ) : null}

        {/* Honest failure detail only - the API redacts secrets and never
            includes answers, resumes, or provider response bodies. */}
        {application.errorCode && status?.phase !== 'OUTCOME_UNKNOWN' ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Reason:</span> {application.errorCode}
            {application.errorMessage ? ` - ${application.errorMessage}` : ''}
          </p>
        ) : null}

        {/* Real provider confirmation only - never fabricated. */}
        {application.externalApplicationId ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Provider reference:</span>{' '}
            {application.externalApplicationId}
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
          <Link
            href={`/applications/${application.id}`}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            Review application
          </Link>

          {/* Targeted recovery actions - the same explicit, server-guarded
              operations as the API. Nothing is automatic. */}
          {status?.phase === 'AWAITING_APPROVAL' ? (
            <Button size="sm" onClick={() => onApprove(application.id)} disabled={acting}>
              {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Approve for submission'}
            </Button>
          ) : null}
          {status?.phase === 'APPROVED' ? (
            <Button size="sm" onClick={() => onSubmit(application.id)} disabled={acting}>
              {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Submit'}
            </Button>
          ) : null}
          {!status?.safeToRetry && status?.phase !== 'SUBMITTED' ? (
            <span className="text-xs text-muted-foreground">
              No automatic resubmission will occur.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function ApplicationsPage() {
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['applications'],
    queryFn: () => applicationsApi.list(1, 20),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => applicationsApi.approve(id),
    onMutate: (id) => setActingId(id),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (err: any) => setErrorMessage(err?.message || 'Approval failed'),
    onSettled: () => setActingId(null),
  });

  const submitMutation = useMutation({
    mutationFn: (id: string) => applicationsApi.submit(id),
    onMutate: (id) => setActingId(id),
    onSuccess: () => {
      setErrorMessage(null);
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (err: any) => setErrorMessage(err?.message || 'Submission could not be queued'),
    onSettled: () => setActingId(null),
  });

  const applications = data?.data ?? [];

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Applications</h1>
          <p className="text-muted-foreground">Track and manage your job applications</p>
        </div>
        <Link href="/jobs" className="flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Import a Job
        </Link>
      </div>

      {errorMessage ? (
        <Card className="border-destructive">
          <CardContent className="py-4 text-sm text-destructive">{errorMessage}</CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Applications could not be loaded. Please refresh and try again.
          </CardContent>
        </Card>
      ) : applications.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Applications</CardTitle>
            <CardDescription>Your job applications will appear here</CardDescription>
          </CardHeader>
          <CardContent className="py-12 text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <FolderKanban className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium">No applications yet</h3>
            <p className="text-muted-foreground mt-2 mb-4">
              Import jobs and start applying to track your applications here.
            </p>
            <Link href="/jobs" className="inline-flex items-center gap-2 text-primary hover:underline">
              <Briefcase className="h-4 w-4" />
              Import a Job
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {applications.map((application) => (
            <ApplicationCard
              key={application.id}
              application={application}
              onApprove={(id) => approveMutation.mutate(id)}
              onSubmit={(id) => submitMutation.mutate(id)}
              acting={actingId === application.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
