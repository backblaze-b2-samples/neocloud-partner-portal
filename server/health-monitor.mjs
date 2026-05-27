// =============================================================================
// health-monitor.mjs — Long-running watchdog for neocloud-api.
//
// Polls http://localhost:3001/api/auth/me every CHECK_INTERVAL_MS. Any HTTP
// response (including 401 Unauthorized) counts as healthy — the server is
// responding. A connection refusal, timeout, or 5xx counts as unhealthy.
//
// After FAILURE_THRESHOLD consecutive unhealthy checks, runs `pm2 restart
// neocloud-api` and waits RESTART_COOLDOWN_MS before resuming checks so the
// new process has time to bind the port.
//
// Designed to run as its own PM2 process (`neocloud-monitor`) with
// autorestart enabled — so if the monitor itself crashes, PM2 brings it back.
//
// Run:
//   pm2 start server/health-monitor.mjs --name neocloud-monitor
//   pm2 save
// =============================================================================

import { exec } from 'node:child_process';

const URL                = process.env.HEALTH_URL || 'http://localhost:3001/api/auth/me';
const CHECK_INTERVAL_MS  = Number(process.env.HEALTH_INTERVAL_MS  || 60_000);   // 1 min
const REQUEST_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS   || 10_000);   // 10s
const FAILURE_THRESHOLD  = Number(process.env.HEALTH_FAIL_COUNT   || 3);        // 3 in a row → restart
const RESTART_COOLDOWN_MS = Number(process.env.HEALTH_COOLDOWN_MS || 60_000);   // 60s after restart
const PM2_TARGET         = process.env.HEALTH_PM2_TARGET || 'neocloud-api';

let consecutiveFailures = 0;
let restartingUntil     = 0; // epoch ms; suppress checks until this passes

const now = () => new Date().toISOString();
const log = (msg) => console.log(`[${now()}] ${msg}`);

async function checkOnce() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(URL, { signal: ctrl.signal });
    // Any HTTP response below 500 means the server is at least responding
    // and serving routes. 401 from /api/auth/me is the expected "alive" case.
    if (res.status < 500) {
      return { ok: true, status: res.status };
    }
    return { ok: false, reason: `http ${res.status}` };
  } catch (e) {
    return { ok: false, reason: e.code || e.name || String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function restartTarget() {
  return new Promise((resolve) => {
    log(`!! Triggering pm2 restart ${PM2_TARGET}`);
    exec(`pm2 restart ${PM2_TARGET}`, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) log(`!! pm2 restart failed: ${err.message}`);
      else    log(`!! pm2 restart ok`);
      if (stdout?.trim()) log(`   stdout: ${stdout.trim().split('\n').pop()}`);
      if (stderr?.trim()) log(`   stderr: ${stderr.trim().split('\n').pop()}`);
      resolve();
    });
  });
}

async function tick() {
  if (Date.now() < restartingUntil) return;

  const r = await checkOnce();
  if (r.ok) {
    if (consecutiveFailures > 0) {
      log(`✓ healthy again (status=${r.status}) after ${consecutiveFailures} failure(s)`);
    }
    consecutiveFailures = 0;
    return;
  }

  consecutiveFailures++;
  log(`✗ unhealthy (${r.reason})  count=${consecutiveFailures}/${FAILURE_THRESHOLD}`);

  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    log(`ALERT  ${PM2_TARGET} unhealthy for ${FAILURE_THRESHOLD} consecutive checks (${r.reason}) — restarting`);
    await restartTarget();
    restartingUntil = Date.now() + RESTART_COOLDOWN_MS;
    consecutiveFailures = 0;
  }
}

log(`health-monitor starting — url=${URL}  interval=${CHECK_INTERVAL_MS}ms  threshold=${FAILURE_THRESHOLD}`);

// Initial check immediately, then on interval.
tick().catch((e) => log(`!! tick error: ${e.message}`));
setInterval(() => {
  tick().catch((e) => log(`!! tick error: ${e.message}`));
}, CHECK_INTERVAL_MS);
