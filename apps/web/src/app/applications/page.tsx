'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { FolderKanban, Plus, Briefcase, FileText, User } from 'lucide-react';
import Link from 'next/link';

export default function ApplicationsPage() {
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

      <div className="grid gap-4 md:grid-cols-3">
        <Link href="/jobs" className="Card hover:shadow-md transition-shadow cursor-pointer">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Briefcase className="h-5 w-5" />
              Import Jobs
            </CardTitle>
            <CardDescription>Add new job opportunities from URLs</CardDescription>
          </CardHeader>
        </Link>
        <Link href="/resumes" className="Card hover:shadow-md transition-shadow cursor-pointer">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Manage Resumes
            </CardTitle>
            <CardDescription>Upload and manage your resumes</CardDescription>
          </CardHeader>
        </Link>
        <Link href="/profile" className="Card hover:shadow-md transition-shadow cursor-pointer">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Complete Profile
            </CardTitle>
            <CardDescription>Keep your profile up to date</CardDescription>
          </CardHeader>
        </Link>
      </div>
    </div>
  );
}