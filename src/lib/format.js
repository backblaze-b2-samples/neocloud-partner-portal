// Number, byte, currency formatters used across the dashboard.

export function bytes(n, opts = {}) {
  if (n == null || isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  const k = opts.binary ? 1024 : 1000;
  let i = 0;
  let v = Math.abs(n);
  while (v >= k && i < units.length - 1) {
    v /= k;
    i++;
  }
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${(n < 0 ? -v : v).toFixed(decimals)} ${units[i]}`;
}

export function compactNumber(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export function currency(n, opts = {}) {
  if (n == null || isNaN(n)) return '—';
  const { compact = false, decimals } = opts;
  if (compact) {
    const abs = Math.abs(n);
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(decimals ?? 2)}`;
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals ?? 2,
    maximumFractionDigits: decimals ?? 2,
  }).format(n);
}

export function percent(n, decimals = 1) {
  if (n == null || isNaN(n)) return '—';
  return `${(n * 100).toFixed(decimals)}%`;
}

export function deltaSign(n) {
  if (n == null || isNaN(n)) return '';
  return n > 0 ? '+' : '';
}

export function shortDate(d) {
  if (d == null) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (!dt || isNaN(dt)) return '—';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function relativeTime(date) {
  if (date == null) return '—';
  const now = Date.now();
  let then;
  if (typeof date === 'number') then = date;
  else if (typeof date === 'string') then = new Date(date).getTime();
  else if (date instanceof Date) then = date.getTime();
  else return '—';
  if (!Number.isFinite(then)) return '—';
  const diff = (now - then) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 14 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  // Older than 2 weeks: show the actual date so "428d ago" doesn't confuse.
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function cx(...args) {
  return args.filter(Boolean).join(' ');
}
