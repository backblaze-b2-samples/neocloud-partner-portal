// =============================================================================
// apiTrace — in-memory capture of the B2 API calls the portal makes, surfaced
// in the UI when "training mode" is on so the portal doubles as a self-
// documenting reference (concept ported from the b2-partner-portal sample).
// =============================================================================
// Security: Authorization headers are masked and known secret fields are
// redacted BEFORE anything is stored, so the trace never holds live secrets
// (master key, B2 auth token, freshly-created application keys, …).
//
// This module is framework-agnostic (no React) so both the b2 adapter and the
// apiClient can record into it, and the UI subscribes for updates.
// =============================================================================

const MAX_ENTRIES = 100;
const MAX_BODY_CHARS = 6000;

let enabled = false;
let buffer = [];
let seq = 0;
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try { fn(buffer); } catch { /* ignore listener errors */ }
  }
}

// Toggled by AppContext when config.trainingMode changes.
export function setTrainingEnabled(on) { enabled = !!on; }
export function isTrainingEnabled() { return enabled; }

export function subscribe(fn) {
  listeners.add(fn);
  fn(buffer);
  return () => listeners.delete(fn);
}

export function getTrace() { return buffer; }
export function clearTrace() { buffer = []; emit(); }

// --- masking / redaction -----------------------------------------------------

export function maskAuthHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^authorization$/i.test(k) && typeof v === 'string') {
      out[k] = v.length > 12 ? `${v.slice(0, 8)}••••••••${v.slice(-4)}` : '••••••••';
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Field names whose VALUE is a secret and must never be stored verbatim.
const SECRET_KEY = /^(applicationkey|masterapplicationkey|authorizationtoken|accountauthorizationtoken|secret.*|password)$/i;

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '••• redacted •••' : redactSecrets(v);
    }
    return out;
  }
  return value;
}

function clampBody(obj) {
  if (obj === undefined) return undefined;
  try {
    const s = JSON.stringify(obj);
    if (s.length <= MAX_BODY_CHARS) return obj;
    return { _truncated: true, preview: `${s.slice(0, MAX_BODY_CHARS)}…` };
  } catch {
    return obj;
  }
}

// --- recording ---------------------------------------------------------------

export function record(call) {
  if (!enabled) return;
  const entry = {
    id: `${Date.now()}-${seq++}`,
    ts: new Date().toISOString(),
    source: call.source || 'client',
    label: call.label || '',
    method: call.method || 'POST',
    url: call.url || '',
    requestHeaders: maskAuthHeaders(call.requestHeaders || {}),
    requestBody: call.requestBody !== undefined ? clampBody(redactSecrets(call.requestBody)) : undefined,
    status: call.status,
    durationMs: call.durationMs,
    responseBody: call.responseBody !== undefined ? clampBody(redactSecrets(call.responseBody)) : undefined,
    error: call.error,
  };
  buffer = [entry, ...buffer].slice(0, MAX_ENTRIES);
  emit();
}

// Record a batch of server-emitted calls (already masked server-side; we mask
// again defensively in record()).
export function recordMany(calls = [], source = 'server') {
  if (!enabled || !Array.isArray(calls)) return;
  // Server sends oldest→newest; record in order so the newest ends up on top.
  for (const c of calls) record({ ...c, source });
}
