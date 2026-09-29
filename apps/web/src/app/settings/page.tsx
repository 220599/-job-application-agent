'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle, Button } from '@/components/ui';
import { Settings, User, Bell, Shield, Palette, Key, Briefcase, FileText, FolderKanban } from 'lucide-react';
import Link from 'next/link';

const settingsSections = [
  {
    title: 'Profile',
    description: 'Manage your personal information',
    icon: User,
    href: '/profile',
  },
  {
    title: 'Notifications',
    description: 'Configure email and push notifications',
    icon: Bell,
    href: '/settings/notifications',
    disabled: true,
  },
  {
    title: 'Security',
    description: 'Password, two-factor authentication',
    icon: Shield,
    href: '/settings/security',
    disabled: true,
  },
  {
    title: 'Appearance',
    description: 'Theme, language, display preferences',
    icon: Palette,
    href: '/settings/appearance',
    disabled: true,
  },
  {
    title: 'API Keys',
    description: 'Manage your API access tokens',
    icon: Key,
    href: '/settings/api',
    disabled: true,
  },
];

export default function SettingsPage() {
  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {settingsSections.map((section) => (
          <Link
            key={section.title}
            href={section.href}
            className={`Card hover:shadow-md transition-shadow cursor-pointer ${
              section.disabled ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <section.icon className="h-5 w-5" />
                {section.title}
              </CardTitle>
              <CardDescription>{section.description}</CardDescription>
            </CardHeader>
            <CardContent>
              {section.disabled && (
                <span className="text-xs text-muted-foreground">Coming soon</span>
              )}
            </CardContent>
          </Link>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Quick Links</CardTitle>
          <CardDescription>Navigate to other sections of the app</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <Link href="/profile" className="Card hover:shadow-md transition-shadow cursor-pointer">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" />
                  Profile
                </CardTitle>
                <CardDescription>Manage your candidate information</CardDescription>
              </CardHeader>
            </Link>
            <Link href="/resumes" className="Card hover:shadow-md transition-shadow cursor-pointer">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Resumes
                </CardTitle>
                <CardDescription>Manage your resume files</CardDescription>
              </CardHeader>
            </Link>
            <Link href="/jobs" className="Card hover:shadow-md transition-shadow cursor-pointer">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Briefcase className="h-5 w-5" />
                  Jobs
                </CardTitle>
                <CardDescription>Import and manage job opportunities</CardDescription>
              </CardHeader>
            </Link>
            <Link href="/applications" className="Card hover:shadow-md transition-shadow cursor-pointer">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FolderKanban className="h-5 w-5" />
                  Applications
                </CardTitle>
                <CardDescription>Track your job applications</CardDescription>
              </CardHeader>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}