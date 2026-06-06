// =============================================================================
// Server-side B2 API-call trace — collects the upstream calls a proxy route
// makes and (only when the client asked, via X-Training-Mode) returns them on
// the response as `_apiCalls` so the training view can show them.
// Authorization headers are masked and secret fields redacted before they ever
// leave the server.
// =============================================================================

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

// Build a per-request collector. `req` is the Express request.
export function traceCollector(req) {
  const on = req.get('X-Training-Mode') === '1';
  const calls = [];
  return {
    on,
    add(call) {
      if (!on) return;
      calls.push({
        source: 'server',
        label: call.label || '',
        method: call.method || 'POST',
        url: call.url || '',
        requestHeaders: maskAuthHeaders(call.requestHeaders || {}),
        requestBody: call.requestBody !== undefined ? redactSecrets(call.requestBody) : undefined,
        status: call.status,
        durationMs: call.durationMs,
        responseBody: call.responseBody !== undefined ? redactSecrets(call.responseBody) : undefined,
        error: call.error,
      });
    },
    // Merge the collected calls into a JSON payload object.
    decorate(payload) {
      if (!on || calls.length === 0) return payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return { ...payload, _apiCalls: calls };
      }
      return { result: payload, _apiCalls: calls };
    },
  };
}
