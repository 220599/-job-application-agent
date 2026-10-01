import { PrismaClient } from '@prisma/client';
import { ingestJobFromUrl } from './apps/api/src/services/job-ingestion.js';

const prisma = new PrismaClient();

async function test() {
  try {
    // First delete existing job if any
    await prisma.job.deleteMany({ where: { url: 'https://job-boards.greenhouse.io/taskrabbit/jobs/8234605' } });
    console.log('Deleted existing job');
    
    // Now test ingestion
    console.log('Testing ingestion...');
    const result = await ingestJobFromUrl('https://job-boards.greenhouse.io/taskrabbit/jobs/8234605', 'dev-user-123');
    console.log('Result:', result.created ? 'created' : 'existing', result.job.id);
    console.log('Job:', result.job.title, result.job.company);
  } catch (err) {
    console.error('Error:', err.message);
    console.error('Stack:', err.stack);
  } finally {
    await prisma.$disconnect();
  }
}

test().catch(err => {
  console.error('Top-level error:', err);
  process.exit(1);
});