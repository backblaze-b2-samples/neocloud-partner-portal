// Live pulse — a real-time-feel activity stream across the portfolio. In demo
// mode it synthesizes plausible events from the bucket/customer/key inventory
// and streams them in; in production this would subscribe to B2 Event
// Notifications. Pure demo dazzle, but it makes the portal feel alive.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Pause, Play, Upload, Download, Trash2, KeyRound, Lock, ShieldAlert } from 'lucide-react';
import { PageHeader, Card, MetricCard, LoadingState } from '../components/ui.jsx';
import { bytes, cx } from '../lib/format.js';
import * as b2 from '../api/b2Adapter.js';
import * as partner from '../api/partnerApi.js';

const KINDS = [
  { op: 'GET',    weight: 50, icon: Download, color: 'text-accent-teal',   bg: 'bg-accent-teal/10',   verb: 'Download from' },
  { op: 'PUT',    weight: 32, icon: Upload,   color: 'text-accent-green',  bg: 'bg-accent-green/10',  verb: 'Upload to' },
  { op: 'DELETE', weight: 6,  icon: Trash2,   color: 'text-bb-red',        bg: 'bg-bb-red/10',        verb: 'Delete from' },
  { op: 'KEY',    weight: 5,  icon: KeyRound, color: 'text-accent-amber',  bg: 'bg-accent-amber/10',  verb: 'Key used' },
  { op: 'LOCK',   weight: 4,  icon: Lock,     color: 'text-accent-violet', bg: 'bg-accent-violet/10', verb: 'Object Lock on' },
  { op: 'DENY',   weight: 3,  icon: ShieldAlert, color: 'text-bb-red',     bg: 'bg-bb-red/10',        verb: 'Access denied on' },
];
const pickWeighted = (arr) => {
  const total = arr.reduce((s, k) => s + k.weight, 0);
  let r = Math.random() * total;
  for (const k of arr) { if ((r -= k.weight) <= 0) return k; }
  return arr[0];
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

let _seq = 0;
function makeEvent(inv) {
  const kind = pickWeighted(KINDS);
  const bucket = inv.buckets.length ? pick(inv.buckets) : { bucketName: 'bucket', customerId: null };
  const cust = inv.byId[bucket.customerId];
  const size = kind.op === 'GET' || kind.op === 'PUT' ? Math.round(Math.random() * 8e9 + 1e6) : 0;
  return {
    id: `ev-${Date.now()}-${_seq++}`,
    kind,
    bucket: bucket.bucketName,
    customer: cust?.name || 'Unknown',
    region: cust?.region || bucket.region || '',
    size,
    ip: `${pick([34, 52, 18, 104])}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}`,
    t: Date.now(),
  };
}

export default function PulseView() {
  const [inv, setInv] = useState(null);
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  const [perMin, setPerMin] = useState(0);
  const tickRef = useRef([]);

  useEffect(() => {
    Promise.all([b2.listBuckets(), partner.getCustomers()])
      .then(([{ buckets }, { customers }]) => {
        const byId = Object.fromEntries((customers || []).map((c) => [c.id, c]));
        const inventory = { buckets: buckets || [], byId };
        setInv(inventory);
        setEvents(Array.from({ length: 12 }, () => makeEvent(inventory)));
      })
      .catch(() => setInv({ buckets: [], byId: {} }));
  }, []);

  useEffect(() => {
    if (!inv || paused) return;
    let timer;
    const schedule = () => {
      timer = setTimeout(() => {
        const e = makeEvent(inv);
        tickRef.current = [...tickRef.current, e.t].filter((t) => Date.now() - t < 60000);
        setPerMin(tickRef.current.length);
        setEvents((prev) => [e, ...prev].slice(0, 50));
        schedule();
      }, 600 + Math.random() * 1600);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [inv, paused]);

  const stats = useMemo(() => {
    const gets = events.filter((e) => e.kind.op === 'GET').length;
    const denies = events.filter((e) => e.kind.op === 'DENY').length;
    const egress = events.filter((e) => e.kind.op === 'GET').reduce((s, e) => s + e.size, 0);
    return { gets, denies, egress };
  }, [events]);

  if (!inv) return <LoadingState label="Connecting to activity stream" />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Insights"
        title="Live pulse"
        subtitle="A real-time view of operations across your customers' storage. In production this streams from B2 Event Notifications."
        actions={
          <button onClick={() => setPaused((p) => !p)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800">
            {paused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
          </button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Events / min" value={perMin || '—'} unit={paused ? 'paused' : 'live'} source="derived" accent="green" icon={<Activity size={16} />} />
        <MetricCard label="Reads (recent)" value={stats.gets} unit={bytes(stats.egress)} source="derived" accent="teal" icon={<Download size={16} />} />
        <MetricCard label="Denied (recent)" value={stats.denies} source="derived" accent={stats.denies ? 'red' : 'green'} icon={<ShieldAlert size={16} />} />
      </div>

      <Card padding="p-0">
        <div className="flex items-center gap-2 border-b border-ink-800 px-5 py-3 text-sm font-semibold text-ink-100">
          <span className={cx('h-2 w-2 rounded-full', paused ? 'bg-ink-500' : 'bg-accent-green live-dot')} />
          Activity stream
        </div>
        <ul className="divide-y divide-ink-800">
          {events.map((e, i) => {
            const Icon = e.kind.icon;
            return (
              <li key={e.id} className={cx('flex items-center gap-3 px-5 py-2.5 text-xs', i === 0 && !paused && 'animate-[pulse_0.6s_ease-out_1]')}>
                <span className={cx('grid h-7 w-7 shrink-0 place-items-center rounded-md', e.kind.bg, e.kind.color)}>
                  <Icon size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-ink-200">{e.kind.verb} </span>
                  <span className="font-mono text-ink-100">{e.bucket}</span>
                  <span className="text-ink-500"> · {e.customer}</span>
                </span>
                {e.size > 0 && <span className="shrink-0 text-ink-400">{bytes(e.size)}</span>}
                <span className="hidden shrink-0 font-mono text-[10.5px] text-ink-500 sm:inline">{e.ip}</span>
                <span className="shrink-0 text-[10.5px] text-ink-500">{i === 0 ? 'just now' : `${i * 2 + 1}s ago`}</span>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
