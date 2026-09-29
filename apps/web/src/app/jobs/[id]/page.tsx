'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { jobsApi } from '@/lib/api';
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
import { formatDate } from '@/lib/utils';
import { ExternalLink, Briefcase, Building, MapPin, Clock, DollarSign, Briefcase as BriefcaseIcon } from 'lucide-react';
import Link from 'next/link';

export default function JobDetailPage() {
  const params = useParams();
  const jobId = params.id as string;

  const {
    data: jobData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['jobs', jobId],
    queryFn: () => jobsApi.get(jobId),
    enabled: !!jobId,
  });

  const job = jobData?.data;

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Link href="/jobs" className="text-sm text-primary hover:underline mb-4 inline-block">
              ← Back to Jobs
            </Link>
            <h1 className="text-2xl font-bold tracking-tight">Job Details</h1>
          </div>
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </CardHeader>
          <CardContent className="space-y-6">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-8 w-1/2" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Link href="/jobs" className="text-sm text-primary hover:underline mb-4 inline-block">
              ← Back to Jobs
            </Link>
            <h1 className="text-2xl font-bold tracking-tight">Job Details</h1>
          </div>
        </div>
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-center">
          <p>Job not found or error loading job details.</p>
          <Link href="/jobs" className="mt-2 inline-block text-primary hover:underline">
            Back to Jobs
          </Link>
        </div>
      </div>
    );
  }

  const getSourceLabel = (source: string) => {
    switch (source) {
      case 'GREENHOUSE':
        return 'Greenhouse';
      case 'LEVER':
        return 'Lever';
      case 'ASHBY':
        return 'Ashby';
      case 'WORKABLE':
        return 'Workable';
      case 'WORKDAY':
        return 'Workday';
      case 'SMARTRECRUITERS':
        return 'SmartRecruiters';
      case 'ICIMS':
        return 'iCIMS';
      case 'BAMBOOHR':
        return 'BambooHR';
      case 'JOBVITE':
        return 'Jobvite';
      case 'TALEO':
        return 'Taleo';
      default:
        return source;
    }
  };

  const getSourceVariant = (source: string) => {
    switch (source) {
      case 'GREENHOUSE':
        return 'default';
      case 'LEVER':
        return 'secondary';
      case 'ASHBY':
        return 'outline';
      case 'WORKABLE':
        return 'secondary';
      case 'WORKDAY':
        return 'destructive';
      default:
        return 'default';
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/jobs" className="text-sm text-primary hover:underline mb-4 inline-block flex items-center gap-1">
            <BriefcaseIcon className="h-4 w-4" />
            Back to Jobs
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">{job.title}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/jobs" className="text-sm text-primary hover:underline">
            ← All Jobs
          </Link>
        </div>
      </div>

      {/* Job Header Card */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="truncate">{job.title}</CardTitle>
            <CardDescription className="flex items-center gap-3 flex-wrap mt-2">
              <div className="flex items-center gap-1">
                <Building className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{job.company}</span>
              </div>
              {job.location && (
                <Badge variant="outline" className="gap-1">
                  <MapPin className="h-3 w-3" />
                  {job.location}
                </Badge>
              )}
              <Badge variant={getSourceVariant(job.source)}>
                {getSourceLabel(job.source)}
              </Badge>
              {job.workMode && (
                <Badge variant="secondary">
                  <BriefcaseIcon className="h-3 w-3 mr-1" />
                  {job.workMode}
                </Badge>
              )}
              {job.employmentType && (
                <Badge variant="outline">{job.employmentType}</Badge>
              )}
              {job.salaryMin && job.salaryMax && (
                <Badge variant="outline">
                  <DollarSign className="h-3 w-3 mr-1" />
                  ${job.salaryMin.toLocaleString()} - ${job.salaryMax.toLocaleString()} {job.salaryCurrency}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Imported: {formatDate(job.discoveredAt)}
              </span>
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              View Original Posting
            </a>
            <Link
              href="/jobs"
              className="text-sm text-muted-foreground hover:text-primary"
            >
              ← Back
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {job.description && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Description</h4>
                <div className="prose prose-sm max-w-none text-muted-foreground whitespace-pre-line">
                  {job.description}
                </div>
              </div>
            )}

            {(job.requirements && job.requirements.length > 0) && (
              <div className="space-y-2 border-t pt-6">
                <h4 className="text-sm font-medium">Requirements</h4>
                <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                  {job.requirements.map((req, i) => (
                    <li key={i}>{req}</li>
                  ))}
                </ul>
              </div>
            )}

            {(job.responsibilities && job.responsibilities.length > 0) && (
              <div className="space-y-2 border-t pt-6">
                <h4 className="text-sm font-medium">Responsibilities</h4>
                <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                  {job.responsibilities.map((resp, i) => (
                    <li key={i}>{resp}</li>
                  ))}
                </ul>
              </div>
            )}

            {(job.skills && job.skills.length > 0) && (
              <div className="space-y-2 border-t pt-6">
                <h4 className="text-sm font-medium">Skills</h4>
                <div className="flex flex-wrap gap-1">
                  {job.skills.map((skill, i) => (
                    <Badge key={i} variant="outline">{skill}</Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="border-t pt-6 space-y-2">
              <h4 className="text-sm font-medium">Details</h4>
              <dl className="grid grid-cols-2 gap-4 text-sm text-muted-foreground">
                <div>
                  <dt className="font-medium">Source</dt>
                  <dd>{getSourceLabel(job.source)}</dd>
                </div>
                <div>
                  <dt className="font-medium">Imported</dt>
                  <dd>{formatDate(job.discoveredAt)}</dd>
                </div>
                {job.postedAt && (
                  <>
                    <dt className="font-medium">Posted</dt>
                    <dd>{formatDate(job.postedAt)}</dd>
                  </>
                )}
                {job.externalId && (
                  <>
                    <dt className="font-medium">External ID</dt>
                    <dd className="font-mono text-xs">{job.externalId}</dd>
                  </>
                )}
              </dl>
            </div>

            <div className="pt-4 border-t flex items-center gap-2">
              <a
                href={job.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline flex items-center gap-1"
              >
                <ExternalLink className="h-3 w-3" />
                View Original Posting
              </a>
              <Link
                href="/jobs"
                className="text-sm text-muted-foreground hover:text-primary"
              >
                ← Back to Jobs
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}