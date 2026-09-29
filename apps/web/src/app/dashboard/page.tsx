'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  candidateApi,
  skillsApi,
  resumeApi,
  jobsApi,
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
import { cn } from '@/lib/cn';
import { calculateProfileCompleteness } from '@/lib/utils';
import {
  Plus,
  Briefcase,
  FileText,
  User,
  ExternalLink,
  FolderKanban,
} from 'lucide-react';

export default function DashboardPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'overview' | 'activities'>('overview');

  // Fetch candidate profile
  const {
    data: profileData,
    isLoading: profileLoading,
    error: profileError,
  } = useQuery({
    queryKey: ['candidate'],
    queryFn: () => candidateApi.get(),
  });

  // Fetch skills
  const {
    data: skillsData,
    isLoading: skillsLoading,
  } = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
  });

  // Fetch resumes
  const {
    data: resumesData,
    isLoading: resumesLoading,
  } = useQuery({
    queryKey: ['resumes'],
    queryFn: () => resumeApi.list(),
  });

  // Fetch jobs
  const {
    data: jobsData,
    isLoading: jobsLoading,
  } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => jobsApi.list(),
  });

  const profile = profileData?.data;
  const skills = skillsData?.data ?? [];
  const resumes = resumesData?.data?.data ?? [];
  const jobs = jobsData?.data?.data ?? [];
  const defaultResume = resumes.find((r) => r.isDefault);

  const profileCompleteness = calculateProfileCompleteness(profile || null, [], [], skills, resumes);

  if (profileLoading || skillsLoading || resumesLoading || jobsLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Welcome back! Here's an overview of your job application profile.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-1/4" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-1/4" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-1" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-6 w-1/2" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (profileError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <div className="rounded-md bg-destructive/10 p-4 text-destructive">
          <p>Error loading profile data. Please try again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome back! Here's an overview of your job application profile.
        </p>
      </div>

      {/* Profile Completeness Section */}
      <Card>
        <CardHeader>
          <CardTitle>Profile Completeness</CardTitle>
          <CardDescription>
            {profileCompleteness.percentage}% complete - Keep building your profile
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4">
            <div className="h-3 w-full rounded-full bg-muted">
              <div
                className="h-3 rounded-full bg-primary transition-all duration-300"
                style={{ width: `${profileCompleteness.percentage}%` }}
              />
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {profileCompleteness.sections.map((section) => (
              <div key={section.id} className="flex items-center gap-2">
                <Badge variant={section.completed ? 'success' : 'outline'}>
                  {section.completed ? '✓' : '○'}
                </Badge>
                <span className="text-sm">
                  {section.completed ? section.title : `Add ${section.title}`}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Profile Info */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div>
              <CardTitle>Profile</CardTitle>
              <CardDescription>Your candidate information</CardDescription>
            </div>
            <User className="h-5 w-5 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {profile ? (
              <div className="space-y-2">
                <p className="font-medium">
                  {profile.firstName} {profile.lastName}
                </p>
                <p className="text-sm text-muted-foreground">
                  {profile.email}
                </p>
                <p className="text-sm text-muted-foreground">
                  {profile.phone || 'No phone provided'}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No profile found.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Resume Count */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div>
              <CardTitle>Resumes</CardTitle>
              <CardDescription>Your uploaded resumes</CardDescription>
            </div>
            <FileText className="h-5 w-5 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold">{resumes.length}</p>
                <p className="text-sm text-muted-foreground">
                  {resumes.length === 1 ? 'resume' : 'resumes'}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => router.push('/resumes')}>
                <Plus className="h-4 w-4 mr-1" />
                Add
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Jobs Count */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div>
              <CardTitle>Jobs</CardTitle>
              <CardDescription>Imported opportunities</CardDescription>
            </div>
            <Briefcase className="h-5 w-5 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold">{jobs.length}</p>
                <p className="text-sm text-muted-foreground">
                  {jobs.length === 1 ? 'job' : 'jobs'}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => router.push('/jobs')}>
                <Plus className="h-4 w-4 mr-1" />
                Import
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Skills Count */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div>
              <CardTitle>Skills</CardTitle>
              <CardDescription>Your professional skills</CardDescription>
            </div>
            <User className="h-5 w-5 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold">{skills.length}</p>
                <p className="text-sm text-muted-foreground">
                  {skills.length === 1 ? 'skill' : 'skills'}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => router.push('/profile')}>
                <Plus className="h-4 w-4 mr-1" />
                Add
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Default Resume */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <div>
            <CardTitle>Default Resume</CardTitle>
            <CardDescription>Resume used for job applications</CardDescription>
          </div>
          <FileText className="h-5 w-5 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {defaultResume ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{defaultResume.name}</p>
                <p className="text-sm text-muted-foreground">
                  {defaultResume.originalFileName} • {new Date(defaultResume.updatedAt).toLocaleDateString()}
                </p>
              </div>
              <Badge variant="success">Active</Badge>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                No default resume set. Set one to use for job applications.
              </p>
              <Button variant="outline" size="sm" onClick={() => router.push('/resumes')}>
                Go to Resumes
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recently Imported Jobs */}
      {jobs.length > 0 && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div>
              <CardTitle>Recent Jobs</CardTitle>
              <CardDescription>Your most recently imported opportunities</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => router.push('/jobs')}>
              View All
              <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {jobs.slice(0, 5).map((job) => (
                <div
                  key={job.id}
                  className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{job.title}</p>
                    <p className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{job.company}</span>
                      {job.location && <span>{job.location}</span>}
                      <Badge variant="outline">{job.source}</Badge>
                      {job.workMode && <Badge variant="secondary">{job.workMode}</Badge>}
                    </p>
                  </div>
                  <a
                    href={job.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline flex items-center gap-1"
                  >
                    View
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common tasks to get started</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Button
              onClick={() => router.push('/jobs')}
              className="h-auto py-4 flex flex-col items-start gap-2"
            >
              <Briefcase className="h-6 w-6" />
              <div>
                <p className="font-medium">Import Job</p>
                <p className="text-sm text-muted-foreground">Add a new job from URL</p>
              </div>
            </Button>
            <Button
              variant="outline"
              onClick={() => router.push('/resumes')}
              className="h-auto py-4 flex flex-col items-start gap-2"
            >
              <FileText className="h-6 w-6" />
              <div>
                <p className="font-medium">Manage Resumes</p>
                <p className="text-sm text-muted-foreground">Upload or update resumes</p>
              </div>
            </Button>
            <Button
              variant="outline"
              onClick={() => router.push('/profile')}
              className="h-auto py-4 flex flex-col items-start gap-2"
            >
              <User className="h-6 w-6" />
              <div>
                <p className="font-medium">Edit Profile</p>
                <p className="text-sm text-muted-foreground">Update your information</p>
              </div>
            </Button>
            <Button
              variant="outline"
              onClick={() => router.push('/applications')}
              className="h-auto py-4 flex flex-col items-start gap-2"
            >
              <FolderKanban className="h-6 w-6" />
              <div>
                <p className="font-medium">Applications</p>
                <p className="text-sm text-muted-foreground">Track your applications</p>
              </div>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}