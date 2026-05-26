// =============================================================================
// apiClient — small fetch wrapper for the auth/admin API.
// =============================================================================
// - Always sends cookies (credentials: 'include') so the server-side session
//   is attached.
// - Reads the double-submit CSRF token from a non-httpOnly cookie ("csrf")
//   and echoes it in the X-CSRF-Token header on state-changing requests.
//   The server requires this match to accept the request.
// - Surfaces non-2xx responses as ApiError so callers can branch on status.
// - Uses generic errors on the surface so the UI never reveals whether an
//   account exists.
// =============================================================================

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function readCookie(name) {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (method !== 'GET' && method !== 'HEAD') {
    const token = readCookie('csrf');
    if (token) headers['X-CSRF-Token'] = token;
  }

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch { /* ignore */ }
  }

  if (!res.ok) {
    const msg = (data && data.error) || res.statusText || 'Request failed';
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

export const api = {
  get:    (path)         => request('GET', path),
  post:   (path, body)   => request('POST', path, body ?? {}),
  put:    (path, body)   => request('PUT', path, body ?? {}),
  patch:  (path, body)   => request('PATCH', path, body ?? {}),
  delete: (path)         => request('DELETE', path),
};
