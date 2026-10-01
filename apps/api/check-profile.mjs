import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function check() {
  const profile = await prisma.candidateProfile.findUnique({ where: { userId: 'dev-user-123' } });
  console.log('Profile:', profile ? 'EXISTS' : 'NOT FOUND');
  if (profile) console.log('Title:', profile.firstName, profile.lastName);
  await prisma.$disconnect();
}
check().catch(console.error);