// Ransomware-protection dashboard — portfolio view of B2 Object Lock
// (immutability) coverage. Shows which buckets have locked, immutable copies
// and which are exposed, framed around the ransomware-resilience story.
import React, { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, ShieldAlert, Lock, Database, RefreshCcw, Info, AlertTriangle,
} from 'lucide-react';
import {
  PageHeader, MetricCard, Card, CardHeader, Tag,
  Table, THead, TBody, TR, TH, TD, LoadingState, ErrorState,
} from '../components/ui.jsx';
import { Modal, ModalFooter } from '../components/Modal.jsx';
import { bytes, compactNumber, percent } from '../lib/format.js';
import { useNav } from '../lib/nav.js';
import * as b2 from '../api/b2Adapter.js';
import * as partner from '../api/partnerApi.js';

function lockMode(b) {
  if (b.fileLock && b.fileLock !== 'none') {
    return b.fileLockConfiguration?.defaultRetention?.mode || b.fileLock;
  }
  return null;
}
function retentionLabel(b) {
  const p = b.fileLockConfiguration?.defaultRetention?.period;
  return p ? `${p.duration} ${p.unit}` : '—';
}

export default function ImmutabilityView() {
  const { navigate } = useNav();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [protect, setProtect] = useState(null); // bucket pending "protect" action

  const load = () => {
    setError(''); setData(null);
    Promise.all([b2.listBuckets(), partner.getCustomers()])
      .then(([{ buckets }, { customers }]) => {
        const nameById = Object.fromEntries((customers || []).map((c) => [c.id, c.name]));
        setData({ buckets: (buckets || []).map((b) => ({ ...b, customerName: nameById[b.customerId] || b.customerId })) });
      })
      .catch((e) => setError(e?.message || String(e)));
  };
  useEffect(load, []);

  const view = useMemo(() => {
    if (!data) return null;
    const buckets = data.buckets;
    const rows = buckets.map((b) => {
      const mode = lockMode(b);
      return {
        ...b,
        mode,
        protectedBytes: mode ? (b.storageBytes || 0) : 0,
        status: mode === 'compliance' ? 'compliance' : mode === 'governance' ? 'governance' : 'exposed',
      };
    }).sort((a, b) => {
      const rank = { exposed: 0, governance: 1, compliance: 2 };
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      return (b.storageBytes || 0) - (a.storageBytes || 0);
    });
    const locked = rows.filter((r) => r.mode);
    const exposed = rows.filter((r) => !r.mode);
    const totalBytes = rows.reduce((s, r) => s + (r.storageBytes || 0), 0);
    const protectedBytes = rows.reduce((s, r) => s + r.protectedBytes, 0);
    const coverage = totalBytes > 0 ? protectedBytes / totalBytes : 0;
    return {
      rows, exposed,
      counts: {
        total: rows.length,
        locked: locked.length,
        compliance: rows.filter((r) => r.status === 'compliance').length,
        governance: rows.filter((r) => r.status === 'governance').length,
        exposed: exposed.length,
      },
      coverage, protectedBytes, exposedBytes: totalBytes - protectedBytes,
    };
  }, [data]);

  if (error) return <ErrorState title="Could not load buckets" message={error} onRetry={load} />;
  if (!view) return <LoadingState label="Checking immutability coverage" />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Security"
        title="Ransomware protection"
        subtitle="Backblaze B2 Object Lock keeps immutable, time-locked copies that ransomware (and rogue admins) cannot alter or delete. Here's your portfolio's coverage."
        actions={
          <button onClick={load} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800">
            <RefreshCcw size={12} /> Refresh
          </button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Immutability coverage" value={percent(view.coverage, 0)} unit="of stored data" source="derived" accent={view.coverage > 0.8 ? 'green' : view.coverage > 0.5 ? 'amber' : 'red'} icon={<Lock size={16} />} />
        <MetricCard label="Protected buckets" value={`${view.counts.locked} / ${view.counts.total}`} source="derived" accent="green" icon={<ShieldCheck size={16} />} />
        <MetricCard label="Compliance-mode" value={view.counts.compliance} unit="hard-locked" source="derived" accent="teal" icon={<Lock size={16} />} />
        <MetricCard label="Exposed buckets" value={view.counts.exposed} unit={bytes(view.exposedBytes)} source="derived" accent={view.counts.exposed ? 'red' : 'green'} icon={<ShieldAlert size={16} />} />
      </div>

      {/* Narrative */}
      <Card className="border-accent-teal/30 bg-accent-teal/5">
        <div className="flex items-start gap-3 text-xs text-ink-200">
          <Info size={18} className="mt-0.5 shrink-0 text-accent-teal" />
          <div>
            <div className="text-sm font-semibold text-ink-100">Why this matters</div>
            <p className="mt-1 leading-relaxed text-ink-300">
              In <span className="font-medium text-ink-100">compliance</span> mode, not even an account admin can delete or
              overwrite a file before its retention period elapses — the gold standard against ransomware and insider threats.
              <span className="font-medium text-ink-100"> Governance</span> mode is the same but can be lifted by a privileged
              key. Buckets with no lock are mutable: a compromised key could encrypt or wipe them.
            </p>
          </div>
        </div>
      </Card>

      {view.exposed.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span><span className="font-semibold">{view.exposed.length} bucket{view.exposed.length === 1 ? '' : 's'}</span> ({bytes(view.exposedBytes)}) have no Object Lock — a single compromised key could delete this data.</span>
        </div>
      )}

      <Card padding="p-0">
        <CardHeader title="Bucket protection" subtitle="Exposed buckets first." className="px-5 pt-5" />
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Bucket</TH><TH>Customer</TH><TH>Lock mode</TH><TH>Retention</TH>
              <TH>Encryption</TH><TH className="text-right">Storage</TH><TH className="text-right">Action</TH>
            </TR>
          </THead>
          <TBody>
            {view.rows.map((b) => (
              <TR key={b.bucketId} onClick={() => navigate('bucket-detail', { bucketId: b.bucketId, accountId: b.accountId })}>
                <TD className="font-mono text-[11.5px] text-ink-100">{b.bucketName}</TD>
                <TD className="text-ink-300">{b.customerName}</TD>
                <TD>
                  {b.mode === 'compliance' ? <Tag variant="success">Compliance</Tag>
                    : b.mode === 'governance' ? <Tag variant="info">Governance</Tag>
                    : <Tag variant="danger">No lock</Tag>}
                </TD>
                <TD className="text-ink-300">{retentionLabel(b)}</TD>
                <TD className="text-ink-300">{b.encryption || 'none'}</TD>
                <TD className="text-right">{bytes(b.storageBytes || 0)}</TD>
                <TD className="text-right">
                  {!b.mode && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setProtect(b); }}
                      className="inline-flex items-center gap-1 rounded border border-accent-green/40 bg-accent-green/10 px-2 py-1 text-[11px] font-medium text-accent-green hover:bg-accent-green/20"
                    >
                      <Lock size={11} /> Protect
                    </button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Modal open={!!protect} onClose={() => setProtect(null)} title="Enable Object Lock" subtitle={protect?.bucketName} size="md">
        <div className="space-y-3 text-xs text-ink-300">
          <p>This would enable Object Lock on <span className="font-mono text-ink-100">{protect?.bucketName}</span> and set a default retention so new versions become immutable for the retention window.</p>
          <div className="rounded-md border border-ink-700 bg-ink-900/60 p-3 font-mono text-[11px] text-ink-300">
            POST /b2api/v4/b2_update_bucket<br />
            {'{'} "bucketId": "{protect?.bucketId}", "fileLockEnabled": true {'}'}
          </div>
          <p className="text-ink-400">In this demo, Object Lock changes are illustrative. In live mode this would call the B2 API with a privileged key and be recorded in the audit log.</p>
        </div>
        <ModalFooter>
          <button onClick={() => setProtect(null)} className="rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-ink-200 hover:bg-ink-800">Close</button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
