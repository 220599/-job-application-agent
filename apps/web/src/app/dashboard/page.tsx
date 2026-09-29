'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  candidateApi,
  skillsApi,
  resumeApi,
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

  const profile = profileData?.data;
  const skills = skillsData?.data ?? [];
  const resumes = resumesData?.data?.data ?? [];
  const defaultResume = resumes.find((r) => r.isDefault);

  const profileCompleteness = calculateProfileCompleteness(profile || null, [], [], skills, resumes);

  if (profileLoading || skillsLoading || resumesLoading) {
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* Profile Info */}
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>Your candidate information</CardDescription>
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
          <CardHeader>
            <CardTitle>Resumes</CardTitle>
            <CardDescription>Your uploaded resumes</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold">{resumes.length}</p>
                <p className="text-sm text-muted-foreground">
                  {resumes.length === 1 ? 'resume' : 'resumes'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Skills Count */}
        <Card>
          <CardHeader>
            <CardTitle>Skills</CardTitle>
            <CardDescription>Your professional skills</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold">{skills.length}</p>
                <p className="text-sm text-muted-foreground">
                  {skills.length === 1 ? 'skill' : 'skills'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Default Resume */}
      <Card>
        <CardHeader>
          <CardTitle>Default Resume</CardTitle>
          <CardDescription>
            Resume used for job applications
          </CardDescription>
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
            <p className="text-sm text-muted-foreground">
              No default resume set. Set one to use for job applications.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common tasks</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              onClick={() => router.push('/profile')}
              className="w-full sm:w-auto"
            >
              Edit Profile
            </Button>
            <Button
              onClick={() => router.push('/resumes')}
              variant="secondary"
              className="w-full sm:w-auto"
            >
              View Resumes
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Jobs Section - Coming Soon */}
      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
          <CardDescription>Your job matches</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Job discovery and matching will be available in a future update.
          </p>
        </CardContent>
      </Card>

      {/* Applications Section - Coming Soon */}
      <Card>
        <CardHeader>
          <CardTitle>Applications</CardTitle>
          <CardDescription>Your job applications</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Automated application submission will be available in a future update.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}