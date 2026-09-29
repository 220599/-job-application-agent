'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  candidateApi,
  educationApi,
  experienceApi,
  skillsApi,
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
  Input,
  Label,
  Textarea,
} from '@/components/ui';
import {
  BasicInformationForm,
  ContactInformationForm,
  ProfessionalLinksForm,
  WorkAuthorizationForm,
  WorkPreferencesForm,
  EducationSection,
  ExperienceSection,
  SkillsSection,
} from '@/components/profile';

export default function ProfilePage() {
  const queryClient = useQueryClient();
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Fetch candidate profile
  const {
    data: profileData,
    isLoading: profileLoading,
    error: profileError,
  } = useQuery({
    queryKey: ['candidate'],
    queryFn: () => candidateApi.get(),
    staleTime: 0,
  });

  const profile = profileData?.data;

  const handleSuccess = (msg: string) => {
    setSuccessMessage(msg);
    setErrorMessage(null);
    setTimeout(() => setSuccessMessage(null), 4000);
  };

  const handleError = (err: any) => {
    setErrorMessage(err?.message || 'An error occurred');
    setSuccessMessage(null);
    setTimeout(() => setErrorMessage(null), 6000);
  };

  if (profileLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
          <p className="text-muted-foreground">
            Manage your candidate profile
          </p>
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <Skeleton className="h-6 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
              </CardHeader>
              <CardContent className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </CardContent>
            </Card>
          </div>
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <Skeleton className="h-6 w-1/2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (profileError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
        <div className="rounded-md bg-destructive/10 p-4 text-destructive">
          <p>Error loading profile data. Please try again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
        <p className="text-muted-foreground">
          Manage your candidate profile information
        </p>
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

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          <BasicInformationForm
            profile={profile}
            onSuccess={handleSuccess}
            onError={handleError}
          />
          <ContactInformationForm
            profile={profile}
            onSuccess={handleSuccess}
            onError={handleError}
          />
          <ProfessionalLinksForm
            profile={profile}
            onSuccess={handleSuccess}
            onError={handleError}
          />
          <WorkAuthorizationForm
            profile={profile}
            onSuccess={handleSuccess}
            onError={handleError}
          />
          <WorkPreferencesForm
            profile={profile}
            onSuccess={handleSuccess}
            onError={handleError}
          />
          <EducationSection
            profile={profile}
            onSuccess={handleSuccess}
            onError={handleError}
          />
          <ExperienceSection
            profile={profile}
            onSuccess={handleSuccess}
            onError={handleError}
          />
          <SkillsSection
            profile={profile}
            onSuccess={handleSuccess}
            onError={handleError}
          />
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Profile Summary</CardTitle>
              <CardDescription>
                Your current profile information
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Name</p>
                <p className="font-medium">
                  {profile.firstName} {profile.lastName}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Email</p>
                <p className="font-medium break-all">{profile.email}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Work Mode</p>
                <p className="font-medium">{profile.preferredWorkMode}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Roles</p>
                <p className="font-medium">
                  {profile.desiredRoles.length > 0
                    ? profile.desiredRoles.join(', ')
                    : 'None specified'}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Locations</p>
                <p className="font-medium">
                  {profile.preferredLocations.length > 0
                    ? profile.preferredLocations.join(', ')
                    : 'None specified'}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}