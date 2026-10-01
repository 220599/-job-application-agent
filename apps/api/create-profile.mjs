import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function createProfile() {
  const profile = await prisma.candidateProfile.create({
    data: {
      userId: 'dev-user-123',
      firstName: 'Dev',
      lastName: 'User',
      email: 'dev@example.com',
      phone: '',
      location: '',
      workAuthorization: 'OTHER',
      sponsorshipRequired: false,
      willingToRelocate: false,
      preferredWorkMode: 'ANY',
      preferredLocations: [],
      desiredRoles: [],
      desiredSalaryMin: null,
      desiredSalaryMax: null,
      summary: '',
    },
  });
  console.log('Profile created:', profile.id);
  await prisma.$disconnect();
}
createProfile().catch(console.error);