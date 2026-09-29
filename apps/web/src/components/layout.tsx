'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

type NavItem = {
  key: string;
  label: string;
  href: string;
  disabled?: boolean;
};

export function MainLayout({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  const navItems: NavItem[] = [
    { key: 'dashboard', label: 'Dashboard', href: '/dashboard' },
    { key: 'profile', label: 'Profile', href: '/profile' },
    { key: 'resumes', label: 'Resumes', href: '/resumes' },
    { key: 'jobs', label: 'Jobs', href: '/jobs' },
    {
      key: 'applications',
      label: 'Applications',
      href: '/applications',
      disabled: true,
    },
    { key: 'settings', label: 'Settings', href: '/settings' },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Top Navigation */}
      <header className="border-b border-input/50 bg-background sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between px-4 py-3">
          {/* Logo / App Name */}
          <h1 className="flex items-center gap-2">
            <span className="text-xl font-bold">Job Application Agent</span>
          </h1>

          {/* User Profile Area */}
          <div className="flex items-center gap-3">
            {/* Settings button */}
            <button
              className="rounded-md bg-transparent p-1.5 hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
              aria-label="Settings"
            >
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </button>

            {/* User avatar / initials */}
            <button
              aria-label="User profile"
              className="flex items-center gap-2 rounded-full border border-input p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span className="font-medium text-sm">
                Dev User
              </span>
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 6v6l4 2" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex flex-1 flex-col">
        {/* Sidebar */}
        <aside
          className={cn(
            'w-64 h-screen bg-card flex-shrink-0 border-r border-input/50 flex flex-col pt-6',
            isMobile && 'hidden'
          )}
        >
          {/* Sidebar Logo */}
          <div className="flex items-center justify-center h-14 border-b border-input/50 mb-6">
            <span className="text-sm font-medium">Job App</span>
          </div>

          {/* Sidebar Navigation */}
          <nav className="flex-1 flex flex-col gap-1">
            {navItems.map((item) => (
              <button
                key={item.key}
                onClick={() => {
                  if (!item.disabled) {
                    // Simple navigation - in a real app this would navigate
                    window.location.href = item.href;
                  }
                }}
                className={cn(
                  'flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  item.disabled
                    ? 'text-muted-foreground cursor-not-allowed opacity-50'
                    : ''
                )}
                disabled={item.disabled}
                aria-disabled={item.disabled}
                aria-label={item.label}
              >
                <svg
                  className="h-4 w-4 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span className="ml-2">{item.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <div className="flex-1 flex-0 overflow-hidden">
          {/* Top bar for mobile sidebar toggle */}
          {isMobile && (
            <div className="p-4 flex items-center justify-between border-b border-input/50">
              <button
                className="rounded-md p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label="Open sidebar"
                onClick={() => {}}
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 12l2-5 10 7-10 7-2-5z" />
                </svg>
              </button>
              <h2 className="font-medium text-lg">{title || 'Job Application Agent'}</h2>
            </div>
          )}

          {/* Page Content */}
          <div className="p-4">{children}</div>
        </div>
      </main>
    </div>
  );
}