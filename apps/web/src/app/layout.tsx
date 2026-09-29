import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Providers } from '@/components/providers';
import { MainLayout } from '@/components/layout';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Job Application Agent',
  description: 'Production-oriented SaaS job application automation platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}

// Page layout wrapper
export function PageLayout({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <Providers>
      <MainLayout title={title}>{children}</MainLayout>
    </Providers>
  );
}