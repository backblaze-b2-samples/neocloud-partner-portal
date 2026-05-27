import React, { useEffect, useState } from 'react';
import {
  ArrowLeft, KeyRound, ShieldCheck, ShieldAlert, Shield, Calendar, Database,
  Activity, Copy, Clock, AlertTriangle, Radio,
} from 'lucide-react';
import {
  PageHeader, Card, CardHeader, MetricCard, SourceBadge, Tag, Tabs,
  Table, THead, TBody, TR, TH, TD, LoadingState, EmptyState,
} from '../components/ui.jsx';
import { TrendAreaChart, StackedBarChart } from '../components/charts.jsx';
import { BUCKETS } from '../data/buckets.js';
import { CUSTOMERS } from '../data/customers.js';
import * as b2 from '../api/b2Adapter.js';
import { deriveKeyCoverage, coverageToAvailability, coverageStatusTitle, getKeyActivityLabel } from '../api/accessLogCoverage.js';
import { useNav } from '../lib/nav.js';
import { useApp } from '../lib/AppContext.jsx';
import { compactNumber, shortDate, relativeTime } from '../lib/format.js';
import { LastUsedCell } from './ApplicationKeysView.jsx';

const POSTURE = {
  good:      { Icon: ShieldCheck,  label: 'Healthy',   tone: 'green',
               desc: 'Bucket-scoped, sensible expiration, recently used.' },
  attention: { Icon: Shield,       label: 'Watch',     tone: 'amber',
               desc: 'Long-lived OR has broad write/delete capabilities. Consider rotating.' },
  expired:   { Icon: ShieldAlert,  label: 'Expired',   tone: 'red',
               desc: 'expirationTimestamp has passed. Calls using this key will be denied.' },
  risk:      { Icon: ShieldAlert,  label: 'At risk',   tone: 'red',
               desc: 'Master-equivalent capabilities with no expiration. Replace immediately.' },
};

export default function KeyDetailView({ keyId, customerId, accountId }) {
  const { navigate } = useNav();
  const { isLive } = useApp();
  const [loading, setLoading] = useState(true);
  const [k, setKey] = useState(null);
  const [lastUsedTs, setLastUsedTs] = useState(null);
  const [bucketStatusMap, setBucketStatusMap] = useState(new Map());

  useEffect(() => {
    Promise.all([
      b2.listApplicationKeys({ customerId, accountId }),
      b2.getKeyLastUsed(),
      b2.listBuckets({ customerId, accountId }),
    ]).then(([{ keys }, { lastUsed }, { buckets }]) => {
      const found = keys.find((x) => x.applicationKeyId === keyId) || null;
      setKey(found);
      setLastUsedTs(lastUsed.get(keyId) || null);
      setBucketStatusMap(new Map(
        buckets.map((bk) => [bk.bucketId, bk.accessLogging || { status: 'not_configured' }])
      ));
      setLoading(false);
    });
  }, [keyId, customerId, accountId]);

  if (loading) return <LoadingState label="Loading application key" />;
  if (!k) {
    return (
      <EmptyState
        title="Key not found"
        message={`No application key with id ${keyId}`}
        action={<button onClick={() => navigate('keys')} className="rounded-md bg-bb-red px-3 py-1.5 text-xs text-white">Back to Keys</button>}
      />
    );
  }

  const Posture = POSTURE[k.posture] || POSTURE.good;
  const customer = CUSTOMERS.find((c) => c.id === k.customerId);
  const accessibleBuckets = k.bucketIds.length === 0
    ? BUCKETS.filter((b) => b.customerId === k.customerId)  // master-equivalent
    : BUCKETS.filter((b) => k.bucketIds.includes(b.bucketId));

  const writeCaps = k.capabilities.filter((c) => c.startsWith('write') || c.startsWith('delete'));
  const readCaps = k.capabilities.filter((c) => c.startsWith('read') || c.startsWith('list') || c === 'shareFiles');

  // Access log coverage — determines whether activity data is available.
  // Critical: "no telemetry" ≠ "no usage". Never show 0-activity metrics
  // unless logs were actually enabled, ingested, and the key was not found.
  const coverage = deriveKeyCoverage(k, bucketStatusMap);
  const activityLabel = getKeyActivityLabel(coverage, lastUsedTs);
  const { availability, reason: coverageReason, label: coverageLabel, detail: coverageDetail } = activityLabel;

  // Show chart only in demo mode when logs are available/partial AND the key
  // actually appears in the sample access log (lastUsedTs !== null).
  // When logs are enabled but no events found → show "no activity observed" panel.
  const showChart = !isLive && (availability === 'available' || availability === 'partial') && lastUsedTs !== null;

  // Synth activity only in demo mode when at least some logs are enabled.
  // In production this would be derived from parsed access log objects.
  const days = 30;
  const usage = showChart ? Array.from({ length: days }, (_, i) => {
    const d = new Date('2026-04-25T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (days - i - 1));
    const seed = (k.applicationKeyId.charCodeAt(2) % 13) + 1;
    const base = 1200 + seed * 80;
    const factor = 0.7 + Math.sin((i + seed) / 3) * 0.4 + Math.random() * 0.2;
    const expired = k.posture === 'expired' && i > 6;
    return {
      date: d.toISOString().slice(0, 10),
      classA: expired ? 0 : Math.round(base * factor * 0.38),
      classB: expired ? 0 : Math.round(base * factor * 0.48),
      classC: expired ? 0 : Math.round(base * factor * 0.10),
      classD: expired ? 0 : Math.round(base * factor * 0.04),
    };
  }) : [];

  const totalA = usage.reduce((s, u) => s + u.classA, 0);
  const totalB = usage.reduce((s, u) => s + u.classB, 0);
  const totalC = usage.reduce((s, u) => s + u.classC, 0);
  const totalD = usage.reduce((s, u) => s + u.classD, 0);

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate('keys')}
        className="inline-flex items-center gap-1 text-xs text-ink-400 hover:text-ink-100"
      >
        <ArrowLeft size={12} /> Back to Keys
      </button>

      <PageHeader
        eyebrow={`Application key · ${customer?.name}`}
        title={k.keyName}
        subtitle={(() => {
          const base = `Key ID ${k.applicationKeyId} · created ${shortDate(k.createdAt)}`;
          if (lastUsedTs) return `${base} · last used ${relativeTime(lastUsedTs)} · from access logs`;
          if (availability === 'available' || availability === 'partial') return `${base} · no activity observed in access logs`;
          return `${base} · per-key telemetry unavailable`;
        })()}
        actions={
          <div className="flex items-center gap-2">
            <PostureBadge posture={k.posture} />
            <button
              onClick={() => navigator.clipboard?.writeText(k.applicationKeyId)}
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800"
            >
              <Copy size={11} /> Copy key ID
            </button>
          </div>
        }
      />

      {/* Hero */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        {showChart ? (
          <>
            <MetricCard label="Class A · 30d" value={compactNumber(totalA)} unit="uploads" source="derived" accent="teal" />
            <MetricCard label="Class B · 30d" value={compactNumber(totalB)} unit="downloads" source="derived" accent="violet" />
            <MetricCard label="Class C · 30d" value={compactNumber(totalC)} unit="metadata" source="derived" accent="amber" />
            <MetricCard label="Class D · 30d" value={compactNumber(totalD)} unit="event notifs" source="derived" accent="red" />
          </>
        ) : coverageReason === 'no_activity_observed' ? (
          <>
            <MetricCard label="Class A · 30d" value="0" unit="no events in logs" source="derived" accent="teal" />
            <MetricCard label="Class B · 30d" value="0" unit="no events in logs" source="derived" accent="violet" />
            <MetricCard label="Class C · 30d" value="0" unit="no events in logs" source="derived" accent="amber" />
            <MetricCard label="Class D · 30d" value="0" unit="no events in logs" source="derived" accent="red" />
          </>
        ) : (
          <>
            <MetricCard label="Class A · 30d" value="—" unit="no telemetry" source="derived" accent="teal" />
            <MetricCard label="Class B · 30d" value="—" unit="no telemetry" source="derived" accent="violet" />
            <MetricCard label="Class C · 30d" value="—" unit="no telemetry" source="derived" accent="amber" />
            <MetricCard label="Class D · 30d" value="—" unit="no telemetry" source="derived" accent="red" />
          </>
        )}
        <MetricCard label="Capabilities" value={k.capabilities.length} source="api" icon={<KeyRound size={14} />} accent="red" />
        <MetricCard
          label="Buckets in scope"
          value={k.bucketIds.length === 0 ? 'all (account-wide)' : k.bucketIds.length}
          source="api"
          icon={<Database size={14} />}
          accent="green"
        />
      </div>

      {/* Posture banner */}
      {(k.posture === 'risk' || k.posture === 'expired') && (
        <div className="flex items-start gap-3 rounded-lg border border-bb-red/30 bg-bb-red/5 p-4">
          <AlertTriangle size={18} className="mt-0.5 text-bb-red" />
          <div className="text-xs">
            <div className="text-sm font-semibold text-bb-red">{Posture.label}</div>
            <p className="mt-1 text-ink-200">{Posture.desc}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="rounded-md bg-bb-red px-3 py-1.5 text-[11px] font-medium text-white hover:bg-bb-redDim">Rotate this key</button>
              <button className="rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-[11px] text-ink-300 hover:bg-ink-800">Disable & alert owner</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          {showChart ? (
            <>
              <CardHeader
                title="API call volume · 30 days"
                subtitle={availability === 'partial'
                  ? `Partial estimate from access logs — ${coverage.coveredCount} of ${coverage.totalCount} buckets have logging enabled. Calls to unlogged buckets are not counted.`
                  : 'Activity derived from Bucket Access Logs. Daily Class A / B / C / D transactions attributed to this key. This is operational telemetry, not official billing.'}
                icon={<Activity size={16} />}
                action={<SourceBadge source="derived" />}
              />
              <TrendAreaChart
                data={usage}
                series={[
                  { key: 'classA', name: 'Class A (uploads, free)',        color: '#3DD9D6', format: compactNumber },
                  { key: 'classB', name: 'Class B (downloads)',            color: '#9B7CFF', format: compactNumber },
                  { key: 'classC', name: 'Class C (metadata)',             color: '#F5B73E', format: compactNumber },
                  { key: 'classD', name: 'Class D (event notifications)',  color: '#F47171', format: compactNumber },
                ]}
                yFormatter={compactNumber}
                height={240}
              />
            </>
          ) : (
            <>
              <CardHeader
                title="Access log coverage"
                subtitle={coverageLabel}
                icon={<Radio size={16} />}
              />
              <div className="space-y-4">
                <p className="text-xs leading-relaxed text-ink-300">{coverageDetail}</p>

                {/* Per-bucket coverage table */}
                {!coverage.isAccountWide && coverage.buckets.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-400">Bucket coverage</div>
                    {coverage.buckets.map((bk) => (
                      <BucketCoverageRow key={bk.bucketId} bucket={bk} />
                    ))}
                  </div>
                )}

                {/* Account-wide key explanation */}
                {coverage.isAccountWide && (
                  <div className="rounded-md bg-ink-900/50 p-3 text-[11.5px] text-ink-400">
                    Access logs are per-bucket. Per-key attribution for account-wide keys requires querying every
                    bucket's log stream and filtering by{' '}
                    <code className="text-ink-200">identity:applicationKey:{k.applicationKeyId}</code>.
                  </div>
                )}

                {/* "No activity observed" note when logs are enabled */}
                {coverageReason === 'no_activity_observed' && (
                  <div className="rounded-md bg-accent-teal/5 px-3 py-2 text-[11px] text-accent-teal ring-1 ring-inset ring-accent-teal/20">
                    Access logs are enabled on all scoped buckets. No requests attributed to this key have been found
                    in the retained log window. This means the key may not have been used since logging was enabled —
                    it does <strong>not</strong> mean the key has never been used.
                  </div>
                )}

                {/* CTA when logs are disabled/misconfigured */}
                {availability === 'unavailable' && !coverage.isAccountWide && coverageReason !== 'no_activity_observed' && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button className="rounded-md bg-bb-red px-3 py-1.5 text-[11px] font-medium text-white hover:bg-bb-redDim">
                      Enable access logging
                    </button>
                    <a
                      href="https://www.backblaze.com/docs/cloud-storage-bucket-access-logs"
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-[11px] text-ink-300 hover:bg-ink-800"
                    >
                      View docs
                    </a>
                  </div>
                )}
              </div>
            </>
          )}
        </Card>

        <Card>
          <CardHeader title="Posture analysis" icon={<Posture.Icon size={16} />} />
          <div className="space-y-2 text-xs">
            <PostureRow ok={k.bucketIds.length > 0} label="Bucket-scoped" desc="Limits blast radius to specific buckets" />
            <PostureRow ok={!!k.namePrefix} label="Prefix-scoped" desc="Restricts access to a subtree (tenant isolation)" />
            <PostureRow ok={!!k.expirationTimestamp} label="Has expiration" desc="Key auto-expires; reduces leaked-credential risk" />
            <PostureRow ok={writeCaps.length === 0 || k.bucketIds.length > 0} label="Limited write surface" desc="Write/delete caps only on specific buckets" />
            <PostureRow
              ok={!k.capabilities.includes('deleteBuckets') && !k.capabilities.includes('writeBucketInfo')}
              label="No bucket-admin capabilities"
              desc="deleteBuckets / writeBucketInfo are master-equivalent"
            />
            <PostureRow
              ok={!!lastUsedTs && (Date.now() - lastUsedTs) < 7 * 86400_000}
              label="Used in last 7 days"
              desc="Stale unused keys are obvious rotation targets"
            />
          </div>
        </Card>
      </div>

      {/* Scope & capabilities */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Scope" icon={<Database size={16} />} />
          <dl className="space-y-1.5 text-xs">
            <KV label="Bucket scope" value={k.bucketIds.length === 0 ? 'account-wide (master-equivalent)' : `${k.bucketIds.length} bucket(s)`} />
            <KV label="Buckets" value={k.bucketName} />
            <KV label="Name prefix" value={k.namePrefix || '(none — entire bucket namespace)'} mono />
            <KV label="Created" value={shortDate(k.createdAt)} />
            <KV label="Expires" value={k.expirationDate || <Tag variant="warn">no expiration set</Tag>} />
            <KV label="Last used" value={<LastUsedCell ts={lastUsedTs} />} />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Capabilities" icon={<KeyRound size={16} />} />
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-accent-teal">Read / list</div>
              <div className="flex flex-wrap gap-1">
                {readCaps.length === 0 && <span className="text-[11px] text-ink-400">none</span>}
                {readCaps.map((c) => <Tag key={c} variant="info">{c}</Tag>)}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-accent-amber">Write / delete</div>
              <div className="flex flex-wrap gap-1">
                {writeCaps.length === 0 && <span className="text-[11px] text-ink-400">none</span>}
                {writeCaps.map((c) => <Tag key={c} variant="warn">{c}</Tag>)}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Accessible buckets */}
      <Card padding="p-0">
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-100">Buckets this key can reach</h3>
            <p className="mt-0.5 text-xs text-ink-300">
              {k.bucketIds.length === 0
                ? 'Account-wide key — all buckets in the customer\'s sub-account are accessible.'
                : 'Restricted to specific bucketIds.'}
            </p>
          </div>
          <SourceBadge source="api" />
        </div>
        {accessibleBuckets.length === 0 ? (
          <EmptyState title="No buckets" message="The key's bucketIds list does not match any current buckets." />
        ) : (
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Bucket</TH>
                <TH>Region</TH>
                <TH className="text-right">Storage</TH>
                <TH className="text-right">Objects</TH>
                <TH></TH>
              </TR>
            </THead>
            <TBody>
              {accessibleBuckets.map((b) => (
                <TR key={b.bucketId} onClick={() => navigate('bucket-detail', { bucketId: b.bucketId, fromCustomer: false })}>
                  <TD>
                    <div className="font-mono text-[12px] text-ink-100">{b.bucketName}</div>
                    <div className="font-mono text-[10.5px] text-ink-400">{b.bucketId.slice(0, 16)}…</div>
                  </TD>
                  <TD className="text-ink-200">{b.region}</TD>
                  <TD className="text-right font-mono">{compactNumber(b.storageBytes)}B</TD>
                  <TD className="text-right font-mono">{compactNumber(b.objectCount)}</TD>
                  <TD className="text-right text-ink-400">›</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function PostureBadge({ posture }) {
  const p = POSTURE[posture] || POSTURE.good;
  const tones = {
    green: 'bg-accent-green/15 text-accent-green ring-accent-green/30',
    amber: 'bg-accent-amber/15 text-accent-amber ring-accent-amber/30',
    red:   'bg-bb-red/15 text-bb-red ring-bb-red/30',
  }[p.tone];
  return (
    <span title={p.desc} className={"inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset cursor-help " + tones}>
      <p.Icon size={12} /> {p.label}
    </span>
  );
}

function PostureRow({ ok, label, desc }) {
  return (
    <div className="flex items-start gap-2">
      <span className={"mt-0.5 inline-block h-1.5 w-1.5 rounded-full " + (ok ? "bg-accent-green" : "bg-bb-red")} />
      <div>
        <div className={"font-medium " + (ok ? "text-ink-100" : "text-bb-red")}>{label}</div>
        <div className="text-[10.5px] text-ink-400">{desc}</div>
      </div>
    </div>
  );
}

function KV({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-ink-400">{label}</dt>
      <dd className={"text-right text-ink-100 " + (mono ? "font-mono break-all" : "")}>{value || '—'}</dd>
    </div>
  );
}

const LOG_STATUS_BADGE = {
  enabled:            { text: 'Enabled',          cls: 'bg-accent-green/15 text-accent-green ring-accent-green/30' },
  waiting:            { text: 'Waiting for logs', cls: 'bg-accent-amber/15 text-accent-amber ring-accent-amber/30' },
  delayed:            { text: 'Delivery delayed', cls: 'bg-accent-amber/15 text-accent-amber ring-accent-amber/30' },
  failed:             { text: 'Logs stale',       cls: 'bg-bb-red/15 text-bb-red ring-bb-red/30' },
  disabled:           { text: 'Logging disabled', cls: 'bg-ink-700/50 text-ink-400 ring-ink-600/30' },
  permission_missing: { text: 'Permission error', cls: 'bg-bb-red/15 text-bb-red ring-bb-red/30' },
  not_configured:     { text: 'Not configured',   cls: 'bg-ink-700/50 text-ink-400 ring-ink-600/30' },
};

function BucketCoverageRow({ bucket }) {
  const badgeInfo = LOG_STATUS_BADGE[bucket.status] || LOG_STATUS_BADGE.not_configured;
  const bucketData = BUCKETS.find((b) => b.bucketId === bucket.bucketId);
  const name = bucketData?.bucketName || bucket.bucketId.slice(0, 16) + '…';

  return (
    <div className="rounded-md bg-ink-900/50 p-3 text-[11.5px] space-y-2">
      {/* Header row: bucket name + status badge */}
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-ink-100">{name}</span>
        <span className={'inline-flex rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset ' + badgeInfo.cls}>
          {badgeInfo.text}
        </span>
      </div>
      {/* Detail rows */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10.5px]">
        {bucket.destinationBucket ? (
          <>
            <CoverageKV label="Destination bucket" value={bucket.destinationBucket} mono />
            <CoverageKV label="Destination prefix" value={bucket.destinationPrefix || '(root)'} mono />
          </>
        ) : (
          <CoverageKV label="Destination" value="Not configured" />
        )}
        <CoverageKV
          label="Last log received"
          value={bucket.lastLogObjectSeenAt ? relativeTime(new Date(bucket.lastLogObjectSeenAt).getTime()) : '—'}
        />
        <CoverageKV
          label="Last ingest"
          value={
            bucket.lastIngestedAt
              ? `${relativeTime(new Date(bucket.lastIngestedAt).getTime())} · ${bucket.lastIngestStatus || '?'}`
              : '—'
          }
        />
        {bucket.lastError && (
          <div className="col-span-2 mt-0.5 text-bb-red">
            <span className="font-medium">Error:</span> {bucket.lastError}
          </div>
        )}
      </div>
    </div>
  );
}

function CoverageKV({ label, value, mono }) {
  return (
    <div>
      <div className="text-ink-500">{label}</div>
      <div className={'text-ink-200 ' + (mono ? 'font-mono' : '')}>{value}</div>
    </div>
  );
}
