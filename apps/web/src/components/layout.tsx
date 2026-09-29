'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import {
  LayoutDashboard,
  Briefcase,
  FileText,
  User,
  Settings,
  FolderKanban,
  Menu,
  X,
  ChevronRight,
} from 'lucide-react';

type NavItem = {
  key: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  disabled?: boolean;
};

const navItems: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { key: 'jobs', label: 'Jobs', href: '/jobs', icon: <Briefcase className="h-4 w-4" /> },
  { key: 'resumes', label: 'Resumes', href: '/resumes', icon: <FileText className="h-4 w-4" /> },
  { key: 'profile', label: 'Profile', href: '/profile', icon: <User className="h-4 w-4" /> },
  { key: 'applications', label: 'Applications', href: '/applications', icon: <FolderKanban className="h-4 w-4" /> },
  { key: 'settings', label: 'Settings', href: '/settings', icon: <Settings className="h-4 w-4" /> },
];

export function MainLayout({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar - Desktop: always visible, Mobile: drawer */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-64 bg-card border-r border-input/50 flex flex-col transition-transform duration-200 ease-in-out',
          'lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
        aria-label="Main navigation"
      >
        {/* Sidebar Header */}
        <div className="flex items-center justify-between h-16 px-4 border-b border-input/50">
          <span className="font-semibold text-lg">Job Application Agent</span>
          <button
            className="lg:hidden p-2 rounded-md hover:bg-accent/10"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Sidebar Navigation */}
        <nav className="flex-1 flex flex-col gap-1 p-4" aria-label="Main navigation">
          {navItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
            return (
              <Link
                key={item.key}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary border-l-2 border-primary'
                    : 'text-muted-foreground hover:bg-accent/10 hover:text-foreground',
                  item.disabled && 'opacity-50 cursor-not-allowed pointer-events-none'
                )}
                aria-current={isActive ? 'page' : undefined}
                aria-disabled={item.disabled}
              >
                <span className={cn('flex-shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')}>
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
                {isActive && <ChevronRight className="h-4 w-4 text-primary ml-auto flex-shrink-0" />}
              </Link>
            );
          })}
        </nav>

        {/* Sidebar Footer */}
        <div className="p-4 border-t border-input/50">
          <p className="text-xs text-muted-foreground text-center">
            Job Application Agent v0.1.0
          </p>
        </div>
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col lg:pl-64 min-w-0">
        {/* Top Header */}
        <header className="sticky top-0 z-20 h-16 bg-background/95 backdrop-blur-sm border-b border-input/50 flex items-center justify-between px-4 lg:px-6">
          {/* Mobile menu button */}
          <button
            className="lg:hidden p-2 rounded-md hover:bg-accent/10"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* Page Title */}
          <div className="flex-1">
            <h1 className="text-xl font-semibold truncate">
              {title || 'Job Application Agent'}
            </h1>
          </div>

          {/* User Profile Area */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full border border-input/50 bg-muted/50 text-sm">
              <span className="font-medium">Dev User</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 p-4 lg:p-6 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}