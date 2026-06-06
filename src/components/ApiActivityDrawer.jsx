// Slide-over panel that lists the B2 API calls behind what the user is doing.
// In live mode it shows the real captured calls (auth masked, secrets redacted);
// in demo mode it shows the representative call catalog from apiExamples.js so
// the portal still teaches the API without making real requests.
import React, { useEffect, useMemo, useState } from 'react';
import { X, Trash2, ChevronRight, FlaskConical, Radio } from 'lucide-react';
import { cx } from '../lib/format.js';
import { subscribe, clearTrace, getTrace } from '../lib/apiTrace.js';
import { JsonView } from './JsonView.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { API_EXAMPLES } from '../data/apiExamples.js';

const METHOD_COLOR = {
  GET:    'bg-accent-teal/15 text-accent-teal ring-accent-teal/30',
  POST:   'bg-accent-violet/15 text-accent-violet ring-accent-violet/30',
  PUT:    'bg-accent-amber/15 text-accent-amber ring-accent-amber/30',
  DELETE: 'bg-bb-red/15 text-bb-red ring-bb-red/30',
};

function StatusPill({ status, error }) {
  if (error) return <span className="rounded bg-bb-red/15 px-1.5 py-0.5 text-[10px] font-medium text-bb-red ring-1 ring-inset ring-bb-red/30">error</span>;
  if (status == null) return null;
  const ok = status < 300;
  return (
    <span className={cx(
      'rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset',
      ok ? 'bg-accent-green/15 text-accent-green ring-accent-green/30' : 'bg-bb-red/15 text-bb-red ring-bb-red/30'
    )}>{status}</span>
  );
}

function ActivityRow({ entry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-ink-800 last:border-b-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-ink-850/60"
      >
        <ChevronRight size={13} className={cx('shrink-0 text-ink-500 transition-transform', open && 'rotate-90')} />
        <span className={cx('shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ring-1 ring-inset', METHOD_COLOR[entry.method] || METHOD_COLOR.POST)}>
          {entry.method}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-100">{entry.label || entry.url}</span>
        {entry.durationMs != null && <span className="shrink-0 text-[10px] text-ink-500">{entry.durationMs}ms</span>}
        <StatusPill status={entry.status} error={entry.error} />
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3 pt-1">
          <div className="break-all font-mono text-[10.5px] text-ink-400">{entry.url}</div>
          {entry.requestHeaders && Object.keys(entry.requestHeaders).length > 0 && (
            <Section label="Request headers"><JsonView value={entry.requestHeaders} /></Section>
          )}
          {entry.requestBody != null && <Section label="Request body"><JsonView value={entry.requestBody} /></Section>}
          {entry.error
            ? <Section label="Error"><JsonView value={entry.error} /></Section>
            : entry.responseBody != null && <Section label="Response"><JsonView value={entry.responseBody} /></Section>}
        </div>
      )}
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</div>
      {children}
    </div>
  );
}

export function ApiActivityDrawer({ open, onClose }) {
  const { isLive } = useApp();
  const [live, setLive] = useState(getTrace());

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const unsub = subscribe(setLive);
    return () => { window.removeEventListener('keydown', onKey); unsub(); };
  }, [open, onClose]);

  // Representative calls for demo mode — mapped to the same entry shape.
  const demoEntries = useMemo(() => API_EXAMPLES.map((ex) => ({
    id: `demo-${ex.id}`,
    source: 'demo',
    label: ex.name,
    method: ex.request.method,
    url: ex.request.url,
    requestHeaders: ex.request.headers,
    requestBody: ex.request.body,
    status: ex.response.status,
    responseBody: ex.response.body,
  })), []);

  const entries = isLive ? live : demoEntries;

  return (
    <div className={cx('fixed inset-0 z-50', !open && 'pointer-events-none')} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={cx('absolute inset-0 bg-ink-950/60 backdrop-blur-sm transition-opacity duration-200', open ? 'opacity-100' : 'opacity-0')}
      />
      <aside
        className={cx(
          'absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-ink-800 bg-ink-900 pb-safe-b pr-safe-r pt-safe-t shadow-2xl transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full'
        )}
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-bb-red/15 text-bb-red">
              {isLive ? <Radio size={14} className="live-dot" /> : <FlaskConical size={14} />}
            </span>
            <div>
              <div className="text-sm font-semibold text-ink-100">B2 API activity</div>
              <div className="text-[10.5px] text-ink-400">
                {isLive ? `${live.length} call${live.length === 1 ? '' : 's'} captured · auth masked` : 'Demo mode · representative calls'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {isLive && live.length > 0 && (
              <button onClick={clearTrace} title="Clear" className="grid h-8 w-8 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100">
                <Trash2 size={14} />
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-ink-400">
              No API calls captured yet. Navigate around in live mode and the real
              B2 requests will appear here.
            </div>
          ) : (
            entries.map((e) => <ActivityRow key={e.id} entry={e} />)
          )}
        </div>
      </aside>
    </div>
  );
}
