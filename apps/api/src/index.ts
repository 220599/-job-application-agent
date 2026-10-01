import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

import { userMiddleware, errorHandler } from './middleware/auth';
import logger from './logger';

// Routes
import candidateRoutes from './routes/candidate';
import educationRoutes from './routes/education';
import experienceRoutes from './routes/experience';
import skillsRoutes from './routes/skills';
import resumesRoutes from './routes/resumes';
import jobsRoutes from './routes/jobs';
import applicationsRoutes from './routes/applications';

// Load env vars: local apps/api/.env first, then repo root .env (no override)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const app = express();
const PORT = process.env.API_PORT || 4001;

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', reason, { promise });
  console.error('UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
  console.error('UNCAUGHT EXCEPTION:', error);
  process.exit(1);
});

// Middleware
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.path}`);
  req.requestId = (req.headers['x-request-id'] as string) || uuidv4();
  next();
});
app.use(userMiddleware);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// API v1 status
app.get('/api/v1/status', (req, res) => {
  res.json({
    status: 'operational',
    version: '0.1.0',
    phase: 'PHASE 2 - Database & API',
  });
});

// API Routes
app.use('/api/candidate', candidateRoutes);
app.use('/api/candidate/education', educationRoutes);
app.use('/api/candidate/experience', experienceRoutes);
app.use('/api/candidate/skills', skillsRoutes);
app.use('/api/resumes', resumesRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/applications', applicationsRoutes);

// 404 handler
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found',
    },
  });
});

// Error handling
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  logger.info(`[API] Server running on http://localhost:${PORT}`);
  logger.info(`[API] Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`[API] DEV_USER_ID: ${process.env.USER_ID || 'dev-user-123'}`);
});

