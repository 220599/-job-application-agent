import { ingestJobFromUrl } from './src/services/job-ingestion.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function test() {
  try {
    console.log('Testing ingestion...');
    const result = await ingestJobFromUrl('https://job-boards.greenhouse.io/taskrabbit/jobs/8234605', 'dev-user-123');
    console.log('Result:', result.created ? 'created' : 'existing', result.job.id);
    await prisma.$disconnect();
  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
    await prisma.$disconnect();
    process.exit(1);
  }
}

test().catch(err => {
  console.error('Top-level error:', err);
  process.exit(1);
});