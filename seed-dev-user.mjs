import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { id: 'dev-user-123' },
    update: {},
    create: {
      id: 'dev-user-123',
      email: 'dev@example.com',
      name: 'Dev User',
    },
  });
  console.log('User created:', user);
}

main().catch(console.error).finally(() => prisma.$disconnect());