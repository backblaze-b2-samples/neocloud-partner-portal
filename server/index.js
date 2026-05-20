// =============================================================================
// Server entry — boots Express, loads env, runs the admin seed, mounts routes.
// =============================================================================
// Run from the project root:
//   npm run server          # dev (loads .env)
//   NODE_ENV=production node server/index.js
//
// In production, set behind HTTPS — Secure cookies require it.
// =============================================================================

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { attachSession } from './middleware/requireAuth.js';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import credentialsRouter from './routes/credentials.js';
import metadataRouter from './routes/customerMetadata.js';
import b2partnerRouter from './routes/b2partner.js';
import customerB2Router from './routes/customerB2.js';
import masterB2Router from './routes/masterB2.js';
import { seedDefaultAdmin } from './seed.js';
import { scheduleObjectCountJob } from './jobs/objectCountJob.js';

const PORT = Number(process.env.PORT || 3001);
const app = express();

// Trust the dev proxy (Vite). In production set this for your real proxy chain.
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 1);

app.use(helmet({
  contentSecurityPolicy: false, // SPA's own CSP is configured at the static layer
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(attachSession);

// Per-request request-id header (helpful for audit correlation).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/credentials', credentialsRouter);
app.use('/api/admin/metadata', metadataRouter);
app.use('/api/b2-partner', b2partnerRouter);
app.use('/api/customer-b2', customerB2Router);
app.use('/api/master-b2', masterB2Router);

// 404 for unknown /api routes — never fall through to anything else.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Generic error handler — never leaks internals.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('[error]', err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal error' });
});

(async () => {
  try {
    await seedDefaultAdmin();
  } catch (e) {
    console.error('[seed] failed:', e?.message || e);
  }
  app.listen(PORT, () => {
    console.log(`[server] listening on :${PORT} (env=${process.env.NODE_ENV || 'development'})`);
    // Start background jobs after the server is accepting connections.
    scheduleObjectCountJob();
  });
})();
