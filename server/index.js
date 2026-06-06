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
import resellerPlansRouter from './routes/resellerPlans.js';
import b2partnerRouter from './routes/b2partner.js';
import customerB2Router from './routes/customerB2.js';
import masterB2Router from './routes/masterB2.js';
import customerAdminRouter from './routes/customerAdmin.js';
import impersonateRouter from './routes/impersonate.js';
import mcpRouter from './routes/mcp.js';
import mcpAdminRouter from './routes/mcpAdmin.js';
import { seedDefaultAdmin, seedDemoUsers, reconcileCustomerLoginsAgainstEjection } from './seed.js';
import { scheduleObjectCountJob } from './jobs/objectCountJob.js';
import { pruneAudit } from './audit.js';

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
app.use('/api/admin/reseller-plans', resellerPlansRouter);
app.use('/api/b2-partner', b2partnerRouter);
app.use('/api/customer-b2', customerB2Router);
app.use('/api/master-b2', masterB2Router);
app.use('/api/customer-admin', customerAdminRouter);
app.use('/api/impersonate', impersonateRouter);
app.use('/api/admin/mcp', mcpAdminRouter);
app.use('/api/mcp', mcpRouter);

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
    await seedDemoUsers();
    reconcileCustomerLoginsAgainstEjection();
  } catch (e) {
    console.error('[seed] failed:', e?.message || e);
  }
  app.listen(PORT, () => {
    console.log(`[server] listening on :${PORT} (env=${process.env.NODE_ENV || 'development'})`);
    // Start background jobs after the server is accepting connections.
    scheduleObjectCountJob();

    // Audit retention — prune entries older than AUDIT_RETENTION_DAYS once
    // per day. Default 365 days (lines up with typical SOC2 / NIST windows).
    // Set to 0 to disable pruning entirely.
    const retention = Number(process.env.AUDIT_RETENTION_DAYS ?? 365);
    if (retention > 0) {
      const prune = () => {
        try {
          const removed = pruneAudit(retention);
          if (removed > 0) console.log(`[audit] pruned ${removed} entries older than ${retention} days`);
        } catch (e) {
          console.error('[audit] prune failed:', e.message);
        }
      };
      // First run 1 min after boot (so we see it in logs), then every 24h.
      setTimeout(prune, 60_000);
      setInterval(prune, 24 * 60 * 60 * 1000);
    }
  });
})();
