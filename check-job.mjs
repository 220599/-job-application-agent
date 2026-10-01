import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function check() {
  const job = await prisma.job.findFirst({ where: { url: 'https://job-boards.greenhouse.io/taskrabbit/jobs/8234605' } });
  console.log('Job:', job);
  await prisma.$disconnect();
}
check().catch(console.error);