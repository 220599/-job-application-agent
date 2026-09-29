'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { resumeApi } from '@/lib/api';
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui';
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui';

interface ResumesPageProps {}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

export default function ResumesPage() {
  const queryClient = useQueryClient();
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const {
    data: resumesData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['resumes'],
    queryFn: () => resumeApi.list(),
  });

  const resumes = resumesData?.data?.data ?? [];
  const pagination = resumesData?.data?.pagination;

  const uploadMutation = useMutation({
    mutationFn: ({ file, name }: { file: File; name: string }) => resumeApi.upload(file, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resumes'] });
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      setShowUploadDialog(false);
      setUploadFile(null);
      setUploadName('');
      setUploadError(null);
      setSuccessMessage('Resume uploaded successfully');
    },
    onError: (err: any) => {
      setUploadError(err?.message || 'Upload failed');
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => resumeApi.setDefault(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resumes'] });
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      setSuccessMessage('Default resume updated');
    },
    onError: (err: any) => setErrorMessage(err?.message || 'Failed to set default resume'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => resumeApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resumes'] });
      queryClient.invalidateQueries({ queryKey: ['candidate'] });
      setSuccessMessage('Resume deleted successfully');
    },
    onError: (err: any) => setErrorMessage(err?.message || 'Failed to delete resume'),
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadFile(file);
      setUploadName(file.name);
      setUploadError(null);
    }
  };

  const validateFile = (file: File): string | null => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return 'Only PDF and DOCX files are allowed';
    }
    if (file.size > MAX_FILE_SIZE) {
      return 'File size must be less than 10 MB';
    }
    return null;
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploadError(null);

    if (!uploadFile) {
      setUploadError('Please select a file');
      return;
    }

    const validationError = validateFile(uploadFile);
    if (validationError) {
      setUploadError(validationError);
      return;
    }

    if (!uploadName.trim()) {
      setUploadError('Please enter a name for the resume');
      return;
    }

    uploadMutation.mutate({ file: uploadFile, name: uploadName.trim() });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getSourceLabel = (source: string) => {
    switch (source) {
      case 'ORIGINAL':
        return 'Original';
      case 'TAILORED':
        return 'Tailored';
      case 'IMPORTED':
        return 'Imported';
      case 'USER_EDITED':
        return 'User Edited';
      case 'AI_GENERATED':
        return 'AI Generated';
      default:
        return source;
    }
  };

  const getSourceVariant = (source: string) => {
    switch (source) {
      case 'ORIGINAL':
        return 'default';
      case 'TAILORED':
        return 'secondary';
      case 'IMPORTED':
        return 'outline';
      case 'USER_EDITED':
        return 'secondary';
      case 'AI_GENERATED':
        return 'destructive';
      default:
        return 'default';
    }
  };

  const handleDelete = (id: string) => {
    // The AlertDialog will handle the confirmation
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Resumes</h1>
          <p className="text-muted-foreground">Manage your resume files</p>
        </div>
        <div className="space-y-4">
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
          <h1 className="text-2xl font-bold tracking-tight">Resumes</h1>
          <p className="text-muted-foreground">Manage your resume files</p>
        </div>
        <div className="rounded-md bg-destructive/10 p-4 text-destructive">
          <p>Error loading resumes. Please try again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Resumes</h1>
          <p className="text-muted-foreground">Manage your resume files</p>
        </div>
        <Button onClick={() => setShowUploadDialog(true)}>
          Upload Resume
        </Button>
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

      {resumes.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
              <svg className="h-8 w-8 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <h3 className="text-lg font-medium">No resumes yet</h3>
            <p className="text-muted-foreground mt-2 mb-4">Upload your first resume to get started</p>
            <Button onClick={() => setShowUploadDialog(true)}>Upload Resume</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {resumes.map((resume) => (
            <Card key={resume.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="truncate">{resume.name}</CardTitle>
                    <CardDescription className="flex items-center gap-3">
                      <span className="font-medium">{resume.originalFileName}</span>
                      <Badge variant="outline">{resume.fileType.toUpperCase()}</Badge>
                      <Badge variant="outline">{formatFileSize(resume.fileSize)}</Badge>
                      <Badge variant={getSourceVariant(resume.versions?.[0]?.source || 'ORIGINAL')}>
                        {getSourceLabel(resume.versions?.[0]?.source || 'ORIGINAL')}
                      </Badge>
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    {resume.isDefault ? (
                      <Badge variant="success">Default</Badge>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDefaultMutation.mutate(resume.id)}
                        disabled={setDefaultMutation.isPending}
                      >
                        Set Default
                      </Button>
                    )}
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
                          <span className="sr-only">Delete resume</span>
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will permanently delete "{resume.name}" and all its versions. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteMutation.mutate(resume.id)}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">
                    Uploaded: {formatDate(resume.createdAt)}
                    {resume.updatedAt !== resume.createdAt && (
                      <> · Updated: {formatDate(resume.updatedAt)}</>
                    )}
                  </div>
                  {resume.versions && resume.versions.length > 1 && (
                    <div className="text-sm text-muted-foreground">
                      {resume.versions.length} version{resume.versions.length > 1 ? 's' : ''}
                    </div>
                  )}
                </div>
                {resume.versions && resume.versions.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <h4 className="text-sm font-medium">Versions</h4>
                    <div className="space-y-1">
                      {resume.versions
                        .slice()
                        .sort((a, b) => b.versionNumber - a.versionNumber)
                        .map((version) => (
                          <div
                            key={version.id}
                            className="flex items-center justify-between text-sm py-1 px-2 rounded border"
                          >
                            <div className="flex items-center gap-2">
                              <Badge variant={getSourceVariant(version.source)}>
                                v{version.versionNumber} - {getSourceLabel(version.source)}
                              </Badge>
                              <span className="text-muted-foreground">
                                {formatDate(version.createdAt)}
                              </span>
                            </div>
                            {version.changeSummary && (
                              <span className="text-muted-foreground">{version.changeSummary}</span>
                            )}
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Upload Dialog */}
      <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Resume</DialogTitle>
            <DialogDescription>
              Upload a PDF or DOCX file (max 10 MB)
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleUpload} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="resume-name">Resume Name *</Label>
              <Input
                id="resume-name"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                disabled={uploadMutation.isPending}
                placeholder="e.g., John Doe - Senior Engineer"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="resume-file">File *</Label>
              <Input
                id="resume-file"
                type="file"
                accept=".pdf,.docx"
                onChange={handleFileChange}
                disabled={uploadMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                PDF or DOCX, max 10 MB
              </p>
            </div>

            {uploadError && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {uploadError}
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowUploadDialog(false)} disabled={uploadMutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={uploadMutation.isPending}>
                {uploadMutation.isPending ? 'Uploading...' : 'Upload'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}