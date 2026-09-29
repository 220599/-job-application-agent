import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.API_PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes will be added in Phase 2
app.get('/api/v1/status', (req, res) => {
  res.json({
    status: 'operational',
    version: '0.1.0',
    phase: 'PHASE 1 - Scaffold',
  });
});

app.listen(PORT, () => {
  console.log(`[API] Server running on http://localhost:${PORT}`);
  console.log(`[API] Environment: ${process.env.NODE_ENV || 'development'}`);
});
