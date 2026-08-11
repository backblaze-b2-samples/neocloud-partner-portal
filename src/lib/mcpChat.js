// =============================================================================
// mcpChat — minimal SSE client for POST /api/mcp/chat.
//
// The shared api helper only parses JSON, so the streaming chat needs its own
// fetch reader. Sends cookies + the double-submit CSRF token the same way
// apiClient does, then parses the Server-Sent Events frames and dispatches each
// to onEvent(event, data).
// =============================================================================

function readCookie(name) {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(
    new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'),
  );
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Stream one chat turn. Resolves when the stream ends.
 * @param body     { messages, decisions? }
 * @param onEvent  (event, data) => void  — one call per SSE frame
 * @param signal   optional AbortSignal
 */
export async function streamChat(body, onEvent, signal) {
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  const csrf = readCookie('csrf');
  if (csrf) headers['X-CSRF-Token'] = csrf;

  const res = await fetch('/api/mcp/chat', {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let msg = 'Chat request failed.';
    try { const j = await res.json(); msg = j.error || msg; } catch { /* non-JSON */ }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
        // lines starting with ':' are heartbeats — ignore
      }
      if (data) {
        try { onEvent(event, JSON.parse(data)); } catch { /* skip malformed frame */ }
      }
    }
  }
}
