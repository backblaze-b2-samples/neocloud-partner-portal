// Reusable UI primitives — Card, MetricCard, badges, tabs, states.

import React from 'react';
import { cx, compactNumber, currency, percent, deltaSign } from '../lib/format.js';
import { ArrowDown, ArrowUp, Loader2, Inbox, AlertTriangle } from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';

// =============================================================================
// Card
// =============================================================================
export function Card({ className, children, padding = 'p-5', ...props }) {
  return (
    <div
      className={cx(
        'rounded-xl border border-ink-700 bg-ink-850/80 shadow-card backdrop-blur-sm',
        padding,
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action, icon, className }) {
  return (
    <div className={cx('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="flex items-start gap-3">
        {icon && (
          <div className="mt-0.5 rounded-lg bg-ink-800 p-2 text-ink-300">{icon}</div>
        )}
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-ink-100">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-300">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// =============================================================================
// Source badge — labels what data source a metric comes from
// =============================================================================
const SOURCE_STYLES = {
  api:     'bg-accent-teal/10 text-accent-teal ring-accent-teal/30',
  csv:     'bg-accent-amber/10 text-accent-amber ring-accent-amber/30',
  derived: 'bg-accent-violet/10 text-accent-violet ring-accent-violet/30',
  partner: 'bg-accent-green/10 text-accent-green ring-accent-green/30',
  db:      'bg-teal-500/10 text-teal-400 ring-teal-500/30',
  demo:    'bg-ink-700 text-ink-300 ring-ink-600',
};
const SOURCE_LABEL = {
  api:     'B2 API',
  csv:     'Daily CSV',
  derived: 'Derived',
  partner: 'Partner API',
  db:      'Index',
  demo:    'Demo only',
};
export function SourceBadge({ source = 'api', className }) {
  const { isLive } = useApp();
  // In live mode the labels are redundant — the data IS live, so hide them.
  if (isLive) return null;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset',
        SOURCE_STYLES[source] || SOURCE_STYLES.demo,
        className
      )}
      title={
        source === 'api'
          ? 'Live data from B2 Native API'
          : source === 'csv'
          ? 'From the Daily Usage CSV report'
          : source === 'derived'
          ? 'Calculated from API + CSV data'
          : source === 'partner'
          ? 'From the Backblaze Partner API'
          : source === 'db'
          ? 'Served from the local SQLite file index (built by the 24-hour background job)'
          : 'Demo placeholder'
      }
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

// =============================================================================
// Metric card — a hero number with optional delta + sparkline area
// =============================================================================
export function MetricCard({
  label,
  value,
  unit,
  delta,           // numeric, like 0.124 for +12.4%
  deltaLabel = 'vs prev 30d',
  source = 'api',
  icon,
  accent = 'red',
  children,        // optional sparkline / chart
  onClick,         // optional — when set, the whole card becomes clickable
  title,           // tooltip on the wrapper
}) {
  const accentRing = {
    red: 'ring-bb-red/30',
    teal: 'ring-accent-teal/30',
    violet: 'ring-accent-violet/30',
    amber: 'ring-accent-amber/30',
    green: 'ring-accent-green/30',
  }[accent];
  const accentBg = {
    red: 'bg-bb-red/10 text-bb-red',
    teal: 'bg-accent-teal/10 text-accent-teal',
    violet: 'bg-accent-violet/10 text-accent-violet',
    amber: 'bg-accent-amber/10 text-accent-amber',
    green: 'bg-accent-green/10 text-accent-green',
  }[accent];
  const positive = delta != null && delta >= 0;

  const clickable = typeof onClick === 'function';
  return (
    <Card
      className={cx(
        'relative overflow-hidden',
        clickable && 'cursor-pointer transition hover:border-ink-600 hover:bg-ink-850/60 focus-within:ring-2 focus-within:ring-bb-red/40'
      )}
      padding="p-5"
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      title={title}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          {icon && (
            <div className={cx('rounded-lg p-1.5 ring-1 ring-inset', accentBg, accentRing)}>{icon}</div>
          )}
          <div className="text-xs font-medium uppercase tracking-wider text-ink-300">
            {label}
          </div>
        </div>
        <SourceBadge source={source} />
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <div className="text-2xl font-semibold text-ink-100">{value}</div>
        {unit && <div className="text-xs text-ink-300">{unit}</div>}
      </div>
      {delta != null && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs">
          <span
            className={cx(
              'inline-flex items-center gap-0.5 rounded font-medium',
              positive ? 'text-accent-green' : 'text-bb-red'
            )}
          >
            {positive ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
            {deltaSign(delta)}
            {percent(delta, 1)}
          </span>
          <span className="text-ink-400">{deltaLabel}</span>
        </div>
      )}
      {children && <div className="mt-3 -mx-1">{children}</div>}
    </Card>
  );
}

// =============================================================================
// Health pill (used in customer rows)
// =============================================================================
export function HealthPill({ status }) {
  const styles = {
    healthy: 'bg-accent-green/15 text-accent-green ring-accent-green/30',
    attention: 'bg-accent-amber/15 text-accent-amber ring-accent-amber/30',
    risk: 'bg-bb-red/15 text-bb-red ring-bb-red/30',
  }[status] || 'bg-ink-700 text-ink-300 ring-ink-600';
  return (
    <span className={cx(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset capitalize',
      styles
    )}>
      <span className={cx('inline-block h-1.5 w-1.5 rounded-full',
        status === 'healthy' ? 'bg-accent-green' : status === 'attention' ? 'bg-accent-amber' : 'bg-bb-red'
      )} />
      {status}
    </span>
  );
}

// =============================================================================
// Tabs
// =============================================================================
export function Tabs({ tabs, value, onChange, className }) {
  return (
    <div className={cx('flex items-center gap-1 rounded-lg bg-ink-850 p-1 ring-1 ring-ink-700', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            value === t.id
              ? 'bg-ink-700 text-ink-100 shadow-sm'
              : 'text-ink-300 hover:text-ink-100 hover:bg-ink-800'
          )}
        >
          {t.label}
          {t.count != null && (
            <span className="ml-1.5 rounded bg-ink-600 px-1 text-[10px] text-ink-200">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// =============================================================================
// Page header
// =============================================================================
export function PageHeader({ title, subtitle, actions, eyebrow }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-6 border-b border-ink-700 pb-5">
      <div>
        {eyebrow && (
          <div className="mb-1 text-[11px] font-medium uppercase tracking-widest text-bb-red">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-ink-100">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-ink-300">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

// =============================================================================
// State components — loading, empty, error
// =============================================================================
export function LoadingState({ label = 'Loading' }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-ink-400">
      <Loader2 className="mb-3 animate-spin" size={28} />
      <p className="text-sm">{label}…</p>
    </div>
  );
}

export function EmptyState({ title = 'Nothing to show', message, icon, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-ink-700 bg-ink-850/40 py-14 text-center">
      <div className="mb-3 rounded-full bg-ink-800 p-3 text-ink-300">
        {icon || <Inbox size={20} />}
      </div>
      <h4 className="text-sm font-semibold text-ink-100">{title}</h4>
      {message && <p className="mt-1 max-w-sm text-xs text-ink-400">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', message, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-bb-red/40 bg-bb-red/5 py-12 text-center">
      <div className="mb-3 rounded-full bg-bb-red/15 p-3 text-bb-red">
        <AlertTriangle size={20} />
      </div>
      <h4 className="text-sm font-semibold text-ink-100">{title}</h4>
      {message && <p className="mt-1 max-w-sm text-xs text-ink-300">{message}</p>}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white hover:bg-bb-redDim"
        >
          Try again
        </button>
      )}
    </div>
  );
}

// =============================================================================
// Generic capability / region tag
// =============================================================================
export function Tag({ children, variant = 'default', className }) {
  const styles = {
    default: 'bg-ink-700 text-ink-200 ring-ink-600',
    info: 'bg-accent-teal/10 text-accent-teal ring-accent-teal/30',
    warn: 'bg-accent-amber/10 text-accent-amber ring-accent-amber/30',
    danger: 'bg-bb-red/10 text-bb-red ring-bb-red/30',
    success: 'bg-accent-green/10 text-accent-green ring-accent-green/30',
    violet: 'bg-accent-violet/10 text-accent-violet ring-accent-violet/30',
  }[variant];
  return (
    <span className={cx(
      'inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset',
      styles, className
    )}>
      {children}
    </span>
  );
}

// =============================================================================
// Table primitive
// =============================================================================
export function Table({ children, className }) {
  return (
    <div className={cx('overflow-x-auto rounded-lg ring-1 ring-ink-700', className)}>
      <table className="min-w-full divide-y divide-ink-700 text-sm">
        {children}
      </table>
    </div>
  );
}
export function THead({ children }) {
  return <thead className="bg-ink-850 text-left text-[11px] font-medium uppercase tracking-wider text-ink-300">{children}</thead>;
}
export function TBody({ children }) {
  return <tbody className="divide-y divide-ink-700 bg-ink-900/40">{children}</tbody>;
}
export function TR({ children, onClick, hover = true }) {
  return (
    <tr
      onClick={onClick}
      className={cx(onClick && 'cursor-pointer', hover && 'hover:bg-ink-850/80 transition-colors')}
    >
      {children}
    </tr>
  );
}
export function TH({ children, className }) {
  return <th className={cx('px-4 py-2.5 font-medium', className)}>{children}</th>;
}
export function TD({ children, className }) {
  return <td className={cx('px-4 py-3 align-middle text-ink-200', className)}>{children}</td>;
}

// Label:value row used to build the mobile card layout that replaces a data
// table on small screens. Pair with `hidden lg:block` on the table and
// `lg:hidden` on the card list. Omit `label` for a full-width row.
export function MobileCardRow({ label, children, className }) {
  return (
    <div className={cx('flex items-start justify-between gap-3 py-1 text-xs', className)}>
      {label && <span className="shrink-0 text-ink-400">{label}</span>}
      <span className="min-w-0 text-right text-ink-200">{children}</span>
    </div>
  );
}

// Helper: render compact byte / number values
export { compactNumber, currency };
