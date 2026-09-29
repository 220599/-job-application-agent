import dotenv from 'dotenv';

dotenv.config();

console.log('[WORKER] Job queue processor starting...');
console.log('[WORKER] Environment:', process.env.NODE_ENV || 'development');
console.log('[WORKER] Redis URL:', process.env.REDIS_URL || 'redis://localhost:6379');
console.log('[WORKER] Database URL: configured');

// Queue setup will be implemented in Phase 14
console.log('[WORKER] Phase 1: Scaffold setup complete');
console.log('[WORKER] Waiting for Phase 2+ implementation...');

// Keep the process alive
process.on('SIGINT', () => {
  console.log('[WORKER] Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[WORKER] Received SIGTERM, shutting down...');
  process.exit(0);
});
