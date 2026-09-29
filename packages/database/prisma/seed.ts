import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // Create a test user
  const user = await prisma.user.create({
    data: {
      email: 'dev@example.com',
      name: 'Alex Johnson',
    },
  });
  console.log('✓ Created user:', user.email);

  // Create candidate profile
  const candidateProfile = await prisma.candidateProfile.create({
    data: {
      userId: user.id,
      firstName: 'Alex',
      lastName: 'Johnson',
      preferredName: 'Alex',
      email: 'alex.johnson@example.com',
      phone: '+1-555-123-4567',
      location: 'San Francisco, CA',
      city: 'San Francisco',
      state: 'CA',
      country: 'United States',
      zipCode: '94105',
      linkedinUrl: 'https://linkedin.com/in/alexjohnson',
      githubUrl: 'https://github.com/alexjohnson',
      portfolioUrl: 'https://alexjohnson.dev',
      workAuthorization: 'US_CITIZEN',
      sponsorshipRequired: false,
      willingToRelocate: true,
      preferredWorkMode: 'HYBRID',
      preferredLocations: ['San Francisco', 'New York', 'Austin'],
      desiredRoles: ['Software Engineer', 'Full Stack Engineer', 'Senior Engineer'],
      desiredSalaryMin: 150000,
      desiredSalaryMax: 250000,
      summary:
        'Experienced full stack software engineer with 8+ years building scalable applications. Strong in TypeScript, React, Node.js, and DevOps.',
    },
  });
  console.log('✓ Created candidate profile');

  // Create education records
  const education1 = await prisma.education.create({
    data: {
      candidateProfileId: candidateProfile.id,
      institution: 'UC Berkeley',
      degree: 'Bachelor of Science',
      fieldOfStudy: 'Computer Science',
      startDate: new Date('2012-09-01'),
      endDate: new Date('2016-05-31'),
      gpa: 3.8,
      description: 'Concentration in Systems and AI',
    },
  });

  const education2 = await prisma.education.create({
    data: {
      candidateProfileId: candidateProfile.id,
      institution: 'Coursera',
      degree: 'Professional Certificate',
      fieldOfStudy: 'Cloud Architecture',
      startDate: new Date('2021-03-01'),
      endDate: new Date('2021-06-30'),
    },
  });
  console.log('✓ Created 2 education records');

  // Create experience records
  const experience1 = await prisma.experience.create({
    data: {
      candidateProfileId: candidateProfile.id,
      company: 'Acme Tech Corp',
      title: 'Senior Software Engineer',
      location: 'San Francisco, CA',
      employmentType: 'FULL_TIME',
      startDate: new Date('2021-06-01'),
      isCurrent: true,
      description:
        'Lead backend development for microservices platform. Improved API performance by 40% through optimization. Mentored 3 junior engineers.',
    },
  });

  const experience2 = await prisma.experience.create({
    data: {
      candidateProfileId: candidateProfile.id,
      company: 'StartupXYZ',
      title: 'Full Stack Engineer',
      location: 'Remote',
      employmentType: 'FULL_TIME',
      startDate: new Date('2019-03-01'),
      endDate: new Date('2021-05-31'),
      description:
        'Built full stack web application with React and Node.js. Implemented CI/CD pipelines using GitHub Actions and Docker.',
    },
  });

  const experience3 = await prisma.experience.create({
    data: {
      candidateProfileId: candidateProfile.id,
      company: 'TechCorp Inc',
      title: 'Software Engineer',
      location: 'New York, NY',
      employmentType: 'FULL_TIME',
      startDate: new Date('2016-07-01'),
      endDate: new Date('2019-02-28'),
      description:
        'Developed frontend features in React. Worked with design team to implement responsive UI. Fixed critical production bugs.',
    },
  });
  console.log('✓ Created 3 experience records');

  // Create skills
  const skills = await Promise.all([
    prisma.skill.create({
      data: {
        candidateProfileId: candidateProfile.id,
        name: 'TypeScript',
        category: 'Programming Language',
        proficiency: 'EXPERT',
        yearsOfExperience: 7,
      },
    }),
    prisma.skill.create({
      data: {
        candidateProfileId: candidateProfile.id,
        name: 'React',
        category: 'Frontend Framework',
        proficiency: 'EXPERT',
        yearsOfExperience: 6,
      },
    }),
    prisma.skill.create({
      data: {
        candidateProfileId: candidateProfile.id,
        name: 'Node.js',
        category: 'Backend Runtime',
        proficiency: 'EXPERT',
        yearsOfExperience: 6,
      },
    }),
    prisma.skill.create({
      data: {
        candidateProfileId: candidateProfile.id,
        name: 'PostgreSQL',
        category: 'Database',
        proficiency: 'ADVANCED',
        yearsOfExperience: 5,
      },
    }),
    prisma.skill.create({
      data: {
        candidateProfileId: candidateProfile.id,
        name: 'Docker',
        category: 'DevOps',
        proficiency: 'ADVANCED',
        yearsOfExperience: 4,
      },
    }),
    prisma.skill.create({
      data: {
        candidateProfileId: candidateProfile.id,
        name: 'Kubernetes',
        category: 'DevOps',
        proficiency: 'INTERMEDIATE',
        yearsOfExperience: 2,
      },
    }),
    prisma.skill.create({
      data: {
        candidateProfileId: candidateProfile.id,
        name: 'AWS',
        category: 'Cloud',
        proficiency: 'ADVANCED',
        yearsOfExperience: 5,
      },
    }),
    prisma.skill.create({
      data: {
        candidateProfileId: candidateProfile.id,
        name: 'GraphQL',
        category: 'API Technology',
        proficiency: 'ADVANCED',
        yearsOfExperience: 3,
      },
    }),
    prisma.skill.create({
      data: {
        candidateProfileId: candidateProfile.id,
        name: 'System Design',
        category: 'Architecture',
        proficiency: 'ADVANCED',
        yearsOfExperience: 4,
      },
    }),
    prisma.skill.create({
      data: {
        candidateProfileId: candidateProfile.id,
        name: 'CI/CD',
        category: 'DevOps',
        proficiency: 'ADVANCED',
        yearsOfExperience: 4,
      },
    }),
  ]);
  console.log('✓ Created 10 skills');

  // Create resumes
  const resume1 = await prisma.resume.create({
    data: {
      userId: user.id,
      name: 'Main Resume',
      originalFileName: 'alex_johnson_resume.pdf',
      fileType: 'pdf',
      storageKey: '/uploads/resumes/alex_johnson_resume_v1.pdf',
      fileSize: 45000,
      mimeType: 'application/pdf',
      isDefault: true,
    },
  });

  const resume2 = await prisma.resume.create({
    data: {
      userId: user.id,
      name: 'Tech-Focused Resume',
      originalFileName: 'alex_johnson_tech_resume.pdf',
      fileType: 'pdf',
      storageKey: '/uploads/resumes/alex_johnson_tech_resume_v1.pdf',
      fileSize: 42000,
      mimeType: 'application/pdf',
      isDefault: false,
    },
  });
  console.log('✓ Created 2 resumes');

  // Create resume versions
  const resumeVersion1 = await prisma.resumeVersion.create({
    data: {
      resumeId: resume1.id,
      versionNumber: 1,
      filePath: '/uploads/resumes/alex_johnson_resume_v1.pdf',
      source: 'ORIGINAL',
      changeSummary: 'Initial upload',
      extractedText: 'Alex Johnson Senior Software Engineer...',
      parsedData: {
        name: 'Alex Johnson',
        email: 'alex.johnson@example.com',
        phone: '+1-555-123-4567',
        summary:
          'Experienced full stack software engineer with 8+ years building scalable applications.',
      },
    },
  });

  const resumeVersion2 = await prisma.resumeVersion.create({
    data: {
      resumeId: resume1.id,
      versionNumber: 2,
      filePath: '/uploads/resumes/alex_johnson_resume_v2.pdf',
      source: 'TAILORED',
      changeSummary: 'Tailored for Backend Role',
      extractedText: 'Alex Johnson Senior Backend Engineer...',
      parsedData: {
        name: 'Alex Johnson',
        email: 'alex.johnson@example.com',
      },
    },
  });

  const resumeVersion3 = await prisma.resumeVersion.create({
    data: {
      resumeId: resume2.id,
      versionNumber: 1,
      filePath: '/uploads/resumes/alex_johnson_tech_resume_v1.pdf',
      source: 'ORIGINAL',
      changeSummary: 'Tech-focused version',
      extractedText: 'Alex Johnson Full Stack Engineer...',
      parsedData: {
        name: 'Alex Johnson',
        email: 'alex.johnson@example.com',
      },
    },
  });
  console.log('✓ Created 3 resume versions');

  // Create jobs
  const job1 = await prisma.job.create({
    data: {
      userId: user.id,
      externalId: 'GH-123456',
      source: 'GREENHOUSE',
      ats: 'GREENHOUSE',
      url: 'https://jobs.lever.co/company/senior-engineer-123456',
      company: 'Acme Cloud Systems',
      title: 'Senior Backend Engineer',
      location: 'San Francisco, CA',
      description:
        'We are looking for a Senior Backend Engineer to join our platform team. You will work on high-scale microservices...',
      employmentType: 'FULL_TIME',
      workMode: 'HYBRID',
      salaryMin: 180000,
      salaryMax: 250000,
      salaryCurrency: 'USD',
      requirements: [
        '7+ years of backend development experience',
        'Expert in Python or Go',
        'Experience with Kubernetes',
        'Strong system design skills',
      ],
      skills: ['Python', 'Go', 'Kubernetes', 'PostgreSQL', 'System Design'],
      postedAt: new Date('2024-09-10'),
    },
  });

  const job2 = await prisma.job.create({
    data: {
      userId: user.id,
      externalId: 'LEVER-789012',
      source: 'LEVER',
      ats: 'LEVER',
      url: 'https://jobs.lever.co/company/fullstack-engineer-789012',
      company: 'InnovateTech Inc',
      title: 'Full Stack Engineer',
      location: 'Remote',
      description: 'Join our team to build next-generation applications...',
      employmentType: 'FULL_TIME',
      workMode: 'REMOTE',
      salaryMin: 140000,
      salaryMax: 200000,
      salaryCurrency: 'USD',
      requirements: [
        '5+ years of full stack development',
        'Strong React and Node.js skills',
        'Experience with TypeScript',
      ],
      skills: ['React', 'Node.js', 'TypeScript', 'PostgreSQL'],
      postedAt: new Date('2024-09-15'),
    },
  });

  const job3 = await prisma.job.create({
    data: {
      userId: user.id,
      source: 'UNKNOWN',
      ats: null,
      url: 'https://careers.example.com/engineering/platform-engineer',
      company: 'Platform Co',
      title: 'Platform Engineer',
      location: 'Austin, TX',
      description: 'Help us build developer tools and infrastructure...',
      employmentType: 'FULL_TIME',
      workMode: 'ONSITE',
      salaryMin: 160000,
      salaryMax: 220000,
      salaryCurrency: 'USD',
      requirements: [
        '6+ years of engineering experience',
        'DevOps or infrastructure background',
        'Go or Rust experience a plus',
      ],
      skills: ['Go', 'DevOps', 'Docker', 'AWS'],
      postedAt: new Date('2024-09-20'),
    },
  });
  console.log('✓ Created 3 jobs');

  // Create job matches
  const jobMatch1 = await prisma.jobMatch.create({
    data: {
      userId: user.id,
      jobId: job1.id,
      score: 92,
      skillsScore: 95,
      experienceScore: 90,
      educationScore: 85,
      locationScore: 95,
      authorizationScore: 100,
      roleScore: 88,
      strengths: [
        'Excellent backend experience',
        'Strong system design skills',
        'Authorized to work in US',
        'Located in target area',
      ],
      gaps: [
        'Limited Go experience (mostly Python)',
        'Moderate Kubernetes experience',
      ],
      warnings: [],
      explanation:
        'Strong fit for this role. You have most required skills and the right experience level.',
    },
  });

  const jobMatch2 = await prisma.jobMatch.create({
    data: {
      userId: user.id,
      jobId: job2.id,
      score: 88,
      skillsScore: 90,
      experienceScore: 85,
      educationScore: 80,
      locationScore: 100,
      authorizationScore: 100,
      roleScore: 85,
      strengths: [
        'Perfect full stack match',
        'Expert in required technologies',
        'Remote-friendly',
      ],
      gaps: [],
      warnings: [],
      explanation: 'Excellent fit for this full stack role.',
    },
  });

  const jobMatch3 = await prisma.jobMatch.create({
    data: {
      userId: user.id,
      jobId: job3.id,
      score: 75,
      skillsScore: 70,
      experienceScore: 80,
      educationScore: 75,
      locationScore: 60,
      authorizationScore: 100,
      roleScore: 75,
      strengths: [
        'Good DevOps foundation',
        'AWS experience',
        'Infrastructure knowledge',
      ],
      gaps: ['No Go/Rust experience', 'Location preference is San Francisco'],
      warnings: ['Would require relocation to Austin'],
      explanation:
        'Moderate fit. You have the foundational skills but lack some specific requirements.',
    },
  });
  console.log('✓ Created 3 job matches');

  // Create applications
  const application1 = await prisma.application.create({
    data: {
      userId: user.id,
      jobId: job1.id,
      resumeVersionId: resumeVersion1.id,
      ats: 'GREENHOUSE',
      applicationUrl: 'https://app.greenhouse.io/application/123456',
      status: 'FORM_FILLED',
      startedAt: new Date('2024-09-21T10:00:00'),
    },
  });

  const application2 = await prisma.application.create({
    data: {
      userId: user.id,
      jobId: job2.id,
      resumeVersionId: resumeVersion1.id,
      ats: 'LEVER',
      applicationUrl: 'https://app.lever.co/application/789012',
      status: 'READY_FOR_REVIEW',
      startedAt: new Date('2024-09-22T14:00:00'),
    },
  });
  console.log('✓ Created 2 applications');

  // Create application questions for app1
  const question1 = await prisma.applicationQuestion.create({
    data: {
      applicationId: application1.id,
      label: 'First Name',
      fieldType: 'TEXT',
      required: true,
      mappedSource: 'PROFILE',
      confidence: 1.0,
    },
  });

  const question2 = await prisma.applicationQuestion.create({
    data: {
      applicationId: application1.id,
      label: 'Why are you interested in this position?',
      fieldType: 'TEXTAREA',
      required: true,
      confidence: 0.0,
    },
  });

  const question3 = await prisma.applicationQuestion.create({
    data: {
      applicationId: application1.id,
      label: 'What is your experience with Kubernetes?',
      fieldType: 'TEXTAREA',
      required: true,
      confidence: 0.0,
    },
  });
  console.log('✓ Created 3 application questions');

  // Create application answers
  await prisma.applicationAnswer.create({
    data: {
      questionId: question1.id,
      answer: 'Alex',
      source: 'PROFILE',
      confidence: 1.0,
      groundedFacts: ['Candidate profile firstName: Alex'],
      approved: true,
    },
  });

  await prisma.applicationAnswer.create({
    data: {
      questionId: question2.id,
      answer:
        'I am excited about the opportunity to work on high-scale microservices at Acme Cloud Systems. With my 8+ years of backend experience and strong system design background, I am confident I can make significant contributions to your platform team. The hybrid work arrangement also aligns perfectly with my preferences.',
      source: 'AI',
      confidence: 0.85,
      needsReview: true,
      groundedFacts: [
        'Resume mentions 8+ years experience',
        'Resume mentions microservices',
        'Profile indicates hybrid preference',
      ],
    },
  });

  await prisma.applicationAnswer.create({
    data: {
      questionId: question3.id,
      answer:
        'I have intermediate to advanced Kubernetes experience. At my current role at Acme Tech Corp, I helped migrate our microservices from Docker Swarm to Kubernetes, managing the containerization of 15+ services and setting up automated scaling policies.',
      source: 'AI',
      confidence: 0.72,
      needsReview: true,
      groundedFacts: [
        'Resume mentions microservices work',
        'Resume mentions Docker containers',
      ],
    },
  });
  console.log('✓ Created 3 application answers');

  // Create application events
  await prisma.applicationEvent.create({
    data: {
      applicationId: application1.id,
      userId: user.id,
      eventType: 'APPLICATION_CREATED',
      status: 'DISCOVERED',
      message: 'Application created for Acme Cloud Systems position',
    },
  });

  await prisma.applicationEvent.create({
    data: {
      applicationId: application1.id,
      userId: user.id,
      eventType: 'MATCH_CALCULATED',
      message: 'Job match calculated: 92% match score',
      metadata: { score: 92 },
    },
  });

  await prisma.applicationEvent.create({
    data: {
      applicationId: application1.id,
      userId: user.id,
      eventType: 'FORM_INSPECTED',
      status: 'FORM_INSPECTED',
      message: 'Application form inspected and fields extracted',
      metadata: { fieldsFound: 3 },
    },
  });

  await prisma.applicationEvent.create({
    data: {
      applicationId: application1.id,
      userId: user.id,
      eventType: 'ANSWER_GENERATED',
      message: 'AI-generated answers for open-ended questions',
      metadata: { questionsAnswered: 2 },
    },
  });

  await prisma.applicationEvent.create({
    data: {
      applicationId: application1.id,
      userId: user.id,
      eventType: 'FORM_FILLED',
      status: 'FORM_FILLED',
      message: 'Application form filled with answers',
    },
  });
  console.log('✓ Created 5 application events');

  // Create automation run
  const automationRun = await prisma.automationRun.create({
    data: {
      userId: user.id,
      applicationId: application1.id,
      provider: 'PLAYWRIGHT',
      status: 'COMPLETED',
      startedAt: new Date('2024-09-21T10:05:00'),
      completedAt: new Date('2024-09-21T10:25:00'),
      metadata: {
        stepsCompleted: 8,
        screenshotsTaken: 3,
        duration: 20,
      },
    },
  });
  console.log('✓ Created automation run');

  console.log('✅ Database seed completed successfully!');
  console.log(`
Total records created:
- 1 User
- 1 Candidate Profile
- 2 Education records
- 3 Experience records
- 10 Skills
- 2 Resumes
- 3 Resume Versions
- 3 Jobs
- 3 Job Matches
- 2 Applications
- 3 Application Questions
- 3 Application Answers
- 5 Application Events
- 1 Automation Run
  `);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
