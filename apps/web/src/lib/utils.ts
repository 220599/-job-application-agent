import type { CandidateProfile, Education, Experience, Skill, Resume } from '@jaa/shared';

export function calculateProfileCompleteness(
  profile: CandidateProfile | null,
  educations: Education[] = [],
  experiences: Experience[] = [],
  skills: Skill[] = [],
  resumes: Resume[] = []
): {
  percentage: number;
  sections: Array<{
    id: string;
    title: string;
    completed: boolean;
    weight: number;
  }>;
} {
  if (!profile) {
    return {
      percentage: 0,
      sections: [
        { id: 'basic-info', title: 'Basic Information', completed: false, weight: 10 },
        { id: 'contact-info', title: 'Contact Information', completed: false, weight: 10 },
        { id: 'professional-links', title: 'Professional Links', completed: false, weight: 10 },
        { id: 'work-auth-prefs', title: 'Work Authorization & Preferences', completed: false, weight: 15 },
        { id: 'education', title: 'Education', completed: false, weight: 15 },
        { id: 'experience', title: 'Experience', completed: false, weight: 15 },
        { id: 'skills', title: 'Skills', completed: false, weight: 15 },
        { id: 'resume', title: 'Resume', completed: false, weight: 10 },
      ],
    };
  }

  const sections = [
    {
      id: 'basic-info',
      title: 'Basic Information',
      completed: !!profile.firstName && !!profile.lastName,
      weight: 10,
    },
    {
      id: 'contact-info',
      title: 'Contact Information',
      completed: !!profile.email || !!profile.phone,
      weight: 10,
    },
    {
      id: 'professional-links',
      title: 'Professional Links',
      completed:
        !!profile.linkedinUrl ||
        !!profile.githubUrl ||
        !!profile.portfolioUrl ||
        !!profile.websiteUrl,
      weight: 10,
    },
    {
      id: 'work-auth-prefs',
      title: 'Work Authorization & Preferences',
      completed:
        !!profile.workAuthorization &&
        !!profile.preferredWorkMode &&
        (profile.preferredLocations?.length ?? 0) > 0,
      weight: 15,
    },
    {
      id: 'education',
      title: 'Education',
      completed: educations.length > 0,
      weight: 15,
    },
    {
      id: 'experience',
      title: 'Experience',
      completed: experiences.length > 0,
      weight: 15,
    },
    {
      id: 'skills',
      title: 'Skills',
      completed: skills.length > 0,
      weight: 15,
    },
    {
      id: 'resume',
      title: 'Resume',
      completed: resumes.some((r) => r.isDefault),
      weight: 10,
    },
  ];

  const totalWeight = sections.reduce((sum, section) => sum + section.weight, 0);
  const completedWeight = sections.reduce(
    (sum, section) => sum + (section.completed ? section.weight : 0),
    0
  );

  const percentage = Math.round((completedWeight / totalWeight) * 100);

  return { percentage, sections };
}

export function formatCurrency(amount: number | undefined, currency = 'USD'): string {
  if (amount === undefined || amount === null) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(date: Date | string | undefined): string {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}