import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backblaze's Native API doesn't send CORS headers, so direct browser→B2
// calls fail with "Failed to fetch". These dev proxies forward the request
// server-side, so the browser only sees same-origin traffic.
//
// To use: in Settings → "CORS proxy URL", paste:
//   http://localhost:5173/b2-proxy
// and the adapter will hit /b2-proxy/b2api/v4/b2_authorize_account → api.backblazeb2.com.
//
// After auth, b2_authorize_account returns a region-specific apiUrl
// (e.g. https://api005.backblazeb2.com). The adapter (src/api/b2Adapter.js)
// rewrites those to /b2-apiNNN under your proxy origin so subsequent calls
// (b2_list_buckets, b2_create_key, …) also flow through this dev proxy.
//
// For PRODUCTION you must run your own backend proxy (Caddy / Cloudflare
// Worker / Express) — never hand a master key to a browser at scale. This
// dev proxy exists only for engineering exploration on localhost.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Auth + admin API (Express backend on :3001)
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: false,
        secure: false,
      },
      // Auth bootstrap (region-agnostic)
      '/b2-proxy': {
        target: 'https://api.backblazeb2.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/b2-proxy/, ''),
      },
      // Region-specific Native API calls. Add one entry per region you use.
      '/b2-api005': { target: 'https://api005.backblazeb2.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/b2-api005/, '') },
      '/b2-api004': { target: 'https://api004.backblazeb2.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/b2-api004/, '') },
      '/b2-api003': { target: 'https://api003.backblazeb2.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/b2-api003/, '') },
      '/b2-api006': { target: 'https://api006.backblazeb2.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/b2-api006/, '') },
      // Region-specific download hosts (for b2_download_file_by_*)
      '/b2-f005': { target: 'https://f005.backblazeb2.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/b2-f005/, '') },
      '/b2-f004': { target: 'https://f004.backblazeb2.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/b2-f004/, '') },
      '/b2-f003': { target: 'https://f003.backblazeb2.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/b2-f003/, '') },
      '/b2-f006': { target: 'https://f006.backblazeb2.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/b2-f006/, '') },
      // Partner API
      '/b2-partner': { target: 'https://api123.backblazeb2.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/b2-partner/, '') },
    },
  },
});
