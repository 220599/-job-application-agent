'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  Input,
  Label,
  Textarea,
} from '@/components/ui';
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui';

export default function JobsPage() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const {
    data: jobsData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => jobsApi.list(),
  });

  const jobs = jobsData?.data?.data ?? [];

  const importMutation = useMutation({
    mutationFn: (url: string) => jobsApi.create(url),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setUrl('');
      setUrlError(null);
      setSuccessMessage(response.data ? 'Job imported successfully' : 'Job already exists');
    },
    onError: (err: any) => {
      setUrlError(err?.message || 'Failed to import job');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      setSuccessMessage('Job deleted successfully');
    },
    onError: (err: any) => setErrorMessage(err?.message || 'Failed to delete job'),
  });

  const validateUrl = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'Only HTTP/HTTPS URLs are allowed';
      }
      return null;
    } catch {
      return 'Invalid URL format';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setUrlError(null);
    setSuccessMessage(null);
    setErrorMessage(null);

    const validationError = validateUrl(url);
    if (validationError) {
      setUrlError(validationError);
      return;
    }

    importMutation.mutate(url);
  };

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const truncate = (text: string | undefined | null, length = 200) => {
    if (!text) return 'No description available';
    return text.length > length ? text.slice(0, length) + '...' : text;
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Jobs</h1>
          <p className="text-muted-foreground">Import and manage job postings</p>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-3/4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-full" />
            </CardContent>
          </Card>
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Jobs</h1>
          <p className="text-muted-foreground">Import and manage job postings</p>
        </div>
        <div className="rounded-md bg-destructive/10 p-4 text-destructive">
          <p>Error loading jobs. Please try again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Jobs</h1>
        <p className="text-muted-foreground">Import and manage job postings</p>
      </div>

      {/* Import Job Form */}
      <Card>
        <CardHeader>
          <CardTitle>Import Job from URL</CardTitle>
          <CardDescription>
            Paste a public job posting URL to extract and save the job information
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="job-url">Job URL</Label>
              <Input
                id="job-url"
                type="url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setUrlError(null);
                }}
                placeholder="https://example.com/job/123"
                disabled={importMutation.isPending}
                className={urlError ? 'border-destructive' : ''}
              />
              {urlError && (
                <p className="text-sm text-destructive">{urlError}</p>
              )}
            </div>

            <Button type="submit" disabled={importMutation.isPending || !url.trim()}>
              {importMutation.isPending ? 'Importing...' : 'Import Job'}
            </Button>
          </form>

          {successMessage && (
            <div className="mt-4 rounded-md bg-green-500/10 p-4 text-green-600 dark:bg-green-500/20">
              <p className="text-sm font-medium">{successMessage}</p>
            </div>
          )}

          {errorMessage && (
            <div className="mt-4 rounded-md bg-destructive/10 p-4 text-destructive">
              <p className="text-sm font-medium">{errorMessage}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Jobs List */}
      {jobs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <svg className="h-8 w-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium">No jobs imported yet</h3>
            <p className="text-muted-foreground mt-2 mb-4">Import your first job by pasting a URL above</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => (
            <Card key={job.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="flex-1 min-w-0">
                  <CardTitle className="truncate">{job.title}</CardTitle>
                  <CardDescription className="flex items-center gap-3 flex-wrap">
                    <span className="font-medium">{job.company}</span>
                    {job.location && (
                      <Badge variant="outline">{job.location}</Badge>
                    )}
                    <Badge variant="outline">{job.source}</Badge>
                    {job.workMode && (
                      <Badge variant="secondary">{job.workMode}</Badge>
                    )}
                    {job.employmentType && (
                      <Badge variant="outline">{job.employmentType}</Badge>
                    )}
                    {job.salaryMin && job.salaryMax && (
                      <Badge variant="outline">
                        ${job.salaryMin.toLocaleString()} - ${job.salaryMax.toLocaleString()} {job.salaryCurrency}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      Imported: {formatDate(job.discoveredAt)}
                    </span>
                  </CardDescription>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={deleteMutation.isPending}
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      <span className="sr-only">Delete job</span>
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete "{job.title}" at {job.company}. This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => deleteMutation.mutate(job.id)}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {job.description && (
                    <div>
                      <h4 className="text-sm font-medium">Description</h4>
                      <p className="text-sm text-muted-foreground whitespace-pre-line">
                        {truncate(job.description, 300)}
                      </p>
                    </div>
                  )}
                  {(job.requirements && job.requirements.length > 0) && (
                    <div>
                      <h4 className="text-sm font-medium">Requirements</h4>
                      <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                        {job.requirements.slice(0, 5).map((req, i) => (
                          <li key={i}>{req}</li>
                        ))}
                        {job.requirements.length > 5 && (
                          <li className="text-xs">+ {job.requirements.length - 5} more</li>
                        )}
                      </ul>
                    </div>
                  )}
                  {(job.responsibilities && job.responsibilities.length > 0) && (
                    <div>
                      <h4 className="text-sm font-medium">Responsibilities</h4>
                      <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                        {job.responsibilities.slice(0, 5).map((resp, i) => (
                          <li key={i}>{resp}</li>
                        ))}
                        {job.responsibilities.length > 5 && (
                          <li className="text-xs">+ {job.responsibilities.length - 5} more</li>
                        )}
                      </ul>
                    </div>
                  )}
                  {(job.skills && job.skills.length > 0) && (
                    <div>
                      <h4 className="text-sm font-medium">Skills</h4>
                      <div className="flex flex-wrap gap-1">
                        {job.skills.slice(0, 10).map((skill, i) => (
                          <Badge key={i} variant="outline">{skill}</Badge>
                        ))}
                        {job.skills.length > 10 && (
                          <Badge variant="outline">+ {job.skills.length - 10} more</Badge>
                        )}
                      </div>
                    </div>
                  )}
                  {job.externalId && (
                    <div className="text-xs text-muted-foreground">
                      External ID: {job.externalId}
                    </div>
                  )}
                  {job.postedAt && (
                    <div className="text-xs text-muted-foreground">
                      Posted: {formatDate(job.postedAt)}
                    </div>
                  )}
                  <div className="pt-2 border-t">
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline flex items-center gap-1"
                    >
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      View Original Posting
                    </a>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}