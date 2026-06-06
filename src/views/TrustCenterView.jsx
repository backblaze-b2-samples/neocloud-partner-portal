// Trust Center — a portfolio-wide security posture score rolled up from the
// per-key posture scoring, bucket encryption, Object Lock coverage, and public
// exposure. Surfaces prioritized findings with remediation + an exportable
// report. Reuses the posture signals already computed by the b2 adapter.
import React, { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, ShieldAlert, Shield, Lock, Download, RefreshCcw, ArrowRight,
} from 'lucide-react';
import {
  PageHeader, MetricCard, Card, CardHeader, Tag, LoadingState, ErrorState,
} from '../components/ui.jsx';
import { percent, compactNumber } from '../lib/format.js';
import { useNav } from '../lib/nav.js';
import * as b2 from '../api/b2Adapter.js';

const SEV = {
  high: { label: 'High', cls: 'bg-bb-red/10 text-bb-red ring-bb-red/30', dot: 'bg-bb-red' },
  med: { label: 'Medium', cls: 'bg-accent-amber/10 text-accent-amber ring-accent-amber/30', dot: 'bg-accent-amber' },
  low: { label: 'Low', cls: 'bg-accent-teal/10 text-accent-teal ring-accent-teal/30', dot: 'bg-accent-teal' },
};

function grade(score) {
  if (score >= 90) return { letter: 'A', accent: 'green' };
  if (score >= 80) return { letter: 'B', accent: 'teal' };
  if (score >= 70) return { letter: 'C', accent: 'amber' };
  if (score >= 60) return { letter: 'D', accent: 'amber' };
  return { letter: 'F', accent: 'red' };
}

export default function TrustCenterView() {
  const { navigate } = useNav();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = () => {
    setError(''); setData(null);
    Promise.all([b2.listApplicationKeys(), b2.listBuckets()])
      .then(([{ keys }, { buckets }]) => setData({ keys: keys || [], buckets: buckets || [] }))
      .catch((e) => setError(e?.message || String(e)));
  };
  useEffect(load, []);

  const view = useMemo(() => {
    if (!data) return null;
    const { keys, buckets } = data;
    const goodKeys = keys.filter((k) => k.posture === 'good').length;
    const riskKeys = keys.filter((k) => k.posture === 'risk');
    const expiredKeys = keys.filter((k) => k.posture === 'expired');
    const attnKeys = keys.filter((k) => k.posture === 'attention');
    const encrypted = buckets.filter((b) => b.encryption && b.encryption !== 'none');
    const locked = buckets.filter((b) => b.fileLock && b.fileLock !== 'none');
    const publicB = buckets.filter((b) => b.bucketType === 'allPublic' || b.publicAccess);
    const unencrypted = buckets.filter((b) => !b.encryption || b.encryption === 'none');
    const exposed = buckets.filter((b) => !b.fileLock || b.fileLock === 'none');

    const keyHealth = keys.length ? goodKeys / keys.length : 1;
    const encCov = buckets.length ? encrypted.length / buckets.length : 1;
    const immCov = buckets.length ? locked.length / buckets.length : 1;
    const publicShare = buckets.length ? publicB.length / buckets.length : 0;
    const score = Math.round(100 * (0.35 * keyHealth + 0.30 * encCov + 0.20 * immCov + 0.15 * (1 - publicShare)));

    const findings = [];
    if (riskKeys.length) findings.push({ sev: 'high', title: `${riskKeys.length} master-equivalent key${riskKeys.length === 1 ? '' : 's'} with no expiry`, detail: 'Account-wide keys with delete/bucket-write capabilities and no expiration. A leak is catastrophic.', fix: 'Rotate to bucket-scoped keys with expirations.', view: 'keys' });
    if (publicB.length) findings.push({ sev: 'high', title: `${publicB.length} public bucket${publicB.length === 1 ? '' : 's'}`, detail: 'Publicly readable buckets expose object data to anyone with the URL.', fix: 'Make private unless public hosting is intended.', view: 'storage' });
    if (expiredKeys.length) findings.push({ sev: 'med', title: `${expiredKeys.length} expired key${expiredKeys.length === 1 ? '' : 's'}`, detail: 'Expired keys are dead weight and signal poor rotation hygiene.', fix: 'Delete expired keys.', view: 'keys' });
    if (unencrypted.length) findings.push({ sev: 'med', title: `${unencrypted.length} bucket${unencrypted.length === 1 ? '' : 's'} without default encryption`, detail: 'Server-side encryption (SSE-B2) is free and on-by-default for new buckets.', fix: 'Enable SSE-B2 default encryption.', view: 'storage' });
    if (exposed.length) findings.push({ sev: 'med', title: `${exposed.length} bucket${exposed.length === 1 ? '' : 's'} without Object Lock`, detail: 'No immutable copy — a compromised key could delete this data.', fix: 'Enable Object Lock on critical buckets.', view: 'immutability' });
    if (attnKeys.length) findings.push({ sev: 'low', title: `${attnKeys.length} key${attnKeys.length === 1 ? '' : 's'} need attention`, detail: 'Long-lived or broadly-scoped keys. Consider tightening.', fix: 'Add expirations and narrow capabilities.', view: 'keys' });

    return {
      score, grade: grade(score), findings,
      stats: {
        keys: keys.length, goodKeys, riskKeys: riskKeys.length,
        buckets: buckets.length, encrypted: encrypted.length, locked: locked.length, publicB: publicB.length,
      },
      coverage: { keyHealth, encCov, immCov, publicShare },
    };
  }, [data]);

  const exportReport = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      trustScore: view.score,
      grade: view.grade.letter,
      summary: view.stats,
      findings: view.findings.map((f) => ({ severity: f.sev, title: f.title, detail: f.detail, remediation: f.fix })),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'trust-center-report.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <ErrorState title="Could not load posture" message={error} onRetry={load} />;
  if (!view) return <LoadingState label="Scoring security posture" />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Security"
        title="Trust Center"
        subtitle="One score for your portfolio's security posture — application keys, encryption, immutability, and public exposure — with prioritized fixes."
        actions={
          <div className="flex items-center gap-2">
            <button onClick={exportReport} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800"><Download size={12} /> Export report</button>
            <button onClick={load} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-3 text-xs text-ink-200 hover:bg-ink-800"><RefreshCcw size={12} /> Refresh</button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px,1fr]">
        {/* Score dial */}
        <Card className="flex flex-col items-center justify-center text-center">
          <div className={'text-6xl font-bold ' + ({ green: 'text-accent-green', teal: 'text-accent-teal', amber: 'text-accent-amber', red: 'text-bb-red' }[view.grade.accent])}>
            {view.score}
          </div>
          <div className="mt-1 text-xs uppercase tracking-widest text-ink-400">Trust score · grade {view.grade.letter}</div>
          <div className="mt-3 w-full">
            <div className="h-2 w-full overflow-hidden rounded-full bg-ink-800">
              <div className={'h-full rounded-full ' + ({ green: 'bg-accent-green', teal: 'bg-accent-teal', amber: 'bg-accent-amber', red: 'bg-bb-red' }[view.grade.accent])} style={{ width: `${view.score}%` }} />
            </div>
          </div>
        </Card>

        {/* Coverage metrics */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricCard label="Healthy keys" value={`${view.stats.goodKeys}/${view.stats.keys}`} source="derived" accent="green" icon={<ShieldCheck size={16} />} />
          <MetricCard label="Encryption coverage" value={percent(view.coverage.encCov, 0)} source="derived" accent="teal" icon={<Shield size={16} />} />
          <MetricCard label="Object Lock coverage" value={percent(view.coverage.immCov, 0)} source="derived" accent="violet" icon={<Lock size={16} />} />
          <MetricCard label="Public buckets" value={view.stats.publicB} source="derived" accent={view.stats.publicB ? 'red' : 'green'} icon={<ShieldAlert size={16} />} />
        </div>
      </div>

      <Card padding="p-0">
        <CardHeader title="Findings" subtitle={`${view.findings.length} issue${view.findings.length === 1 ? '' : 's'} — highest severity first.`} className="px-5 pt-5" />
        {view.findings.length === 0 ? (
          <div className="px-5 pb-5 text-sm text-accent-green">All clear — no posture issues detected. 🎉</div>
        ) : (
          <ul className="divide-y divide-ink-800">
            {view.findings.map((f, i) => (
              <li key={i} className="flex items-start gap-3 px-5 py-3">
                <span className={'mt-1 h-2 w-2 shrink-0 rounded-full ' + SEV[f.sev].dot} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink-100">{f.title}</span>
                    <span className={'rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ' + SEV[f.sev].cls}>{SEV[f.sev].label}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-400">{f.detail}</p>
                  <p className="mt-1 text-xs text-ink-300"><span className="font-medium text-ink-200">Fix:</span> {f.fix}</p>
                </div>
                <button onClick={() => navigate(f.view)} className="mt-1 inline-flex shrink-0 items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800">
                  Review <ArrowRight size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
