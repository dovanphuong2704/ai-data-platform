import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

import { authRouter } from './routes/auth';
import { connectionsRouter } from './routes/connections';
import { keysRouter } from './routes/keys';
import { queryRouter } from './routes/query';
import { queryCancelRouter } from './routes/query-cancel';
import { chatRouter, clearAllSchemaCache } from './routes/chat';
import { chatSessionsRouter } from './routes/chat-sessions';
import { dashboardRouter } from './routes/dashboard';
import { historyRouter } from './routes/history';
import { savedQueriesRouter } from './routes/saved-queries';
import { schedulingRouter } from './routes/scheduling';
import { alertWebhooksRouter } from './routes/alert-webhooks';
import { explorerRouter } from './routes/explorer';
import { quotaRouter } from './routes/quota';
import { scheduler } from './utils/scheduler';
import { alertRunner } from './utils/alert-runner';
import { initDB } from './services/db';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Global Middleware ──────────────────────────────────────────────────────

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Parse JSON bodies (with size limit)
app.use(express.json({ limit: '10mb' }));

// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true }));

// Parse cookies (for JWT cookie auth)
app.use(cookieParser());

// ─── Request Logging (non-production) ─────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ─── Health Check (MUST be before schedulingRouter — it mounts at /api with auth) ──
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    version: 'v3',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    env: process.env.NODE_ENV ?? 'development',
  });
});

app.get('/api/debug', (_req: Request, res: Response) => {
  res.json({ debug: 'ok', timestamp: new Date().toISOString() });
});

// Clear schema cache (development/debug)
app.post('/api/debug/clear-schema-cache', (_req: Request, res: Response) => {
  clearAllSchemaCache();
  res.json({ success: true, message: 'Schema cache cleared' });
});

// ─── Routes ────────────────────────────────────────────────────────────────

app.use('/api/auth', authRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/keys', keysRouter);
app.use('/api/query', queryRouter);
app.use('/api/query', queryCancelRouter);   // /api/query/cancel, /api/query/active
app.use('/api/chat', chatRouter);
app.use('/api/chat-sessions', chatSessionsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api', explorerRouter);  // /api/explorer/schema-info
app.use('/api/history', historyRouter);
app.use('/api/saved-queries', savedQueriesRouter);
app.use('/api', schedulingRouter);         // /api/scheduled-queries, /api/alerts
app.use('/api', alertWebhooksRouter);      // /api/alerts/:id/webhooks
app.use('/api/quota', quotaRouter);

// ─── 404 Handler ──────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global Error Handler ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Error]', err.message);
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────

initDB()
  .then(async () => {
    // Start background services after DB is ready
    await scheduler.start();
    alertRunner.start();

    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/api/health`);
    });
  })
  .catch((err: Error) => {
    console.error('❌ Failed to initialize database:', err.message);
    process.exit(1);
  });

export default app;
