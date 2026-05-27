import React, { useEffect, useState } from 'react';
import {
  KeyRound, Shield, ShieldAlert, ShieldCheck, Calendar, Code2, Bell, ExternalLink,
} from 'lucide-react';
import {
  PageHeader, Card, CardHeader, MetricCard, SourceBadge, Tag, Tabs,
  Table, THead, TBody, TR, TH, TD, LoadingState,
} from '../components/ui.jsx';
import * as b2 from '../api/b2Adapter.js';
import { deriveKeyCoverage, coverageToAvailability, coverageStatusBadge, getKeyActivityLabel } from '../api/accessLogCoverage.js';
import { CUSTOMERS } from '../data/customers.js';
import { relativeTime } from '../lib/format.js';
import { useNav } from '../lib/nav.js';

const POSTURE_STYLES = {
  good:      { icon: ShieldCheck, color: 'text-accent-green', bg: 'bg-accent-green/10', ring: 'ring-accent-green/30', label: 'Healthy',
               desc: 'Bucket-scoped, has a sensible expiration, used recently.' },
  attention: { icon: Shield,      color: 'text-accent-amber', bg: 'bg-accent-amber/10', ring: 'ring-accent-amber/30', label: 'Watch',
               desc: 'Long-lived (no expiry) OR has broad write/delete capabilities. Consider rotating.' },
  expired:   { icon: ShieldAlert, color: 'text-bb-red',       bg: 'bg-bb-red/10',       ring: 'ring-bb-red/30',       label: 'Expired',
               desc: 'expirationTimestamp has passed. Calls using this key will be denied.' },
  risk:      { icon: ShieldAlert, color: 'text-bb-red',       bg: 'bg-bb-red/10',       ring: 'ring-bb-red/30',       label: 'At risk',
               desc: 'Master-equivalent capabilities (deleteBuckets, writeBucketInfo) with no expiration. Replace immediately.' },
};

const POSTURE_TABS = [
  { id: 'all', label: 'All keys' },
  { id: 'good', label: 'Healthy' },
  { id: 'attention', label: 'Watch' },
  { id: 'risk', label: 'At risk' },
  { id: 'expired', label: 'Expired' },
];

export default function ApplicationKeysView({ lockedCustomerId, lockedAccountId } = {}) {
  const { navigate } = useNav();
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState([]);
  const [lastUsed, setLastUsed] = useState(new Map());
  const [bucketStatusMap, setBucketStatusMap] = useState(new Map());
  const [tab, setTab] = useState('all');

  useEffect(() => {
    Promise.all([
      b2.listApplicationKeys({ customerId: lockedCustomerId, accountId: lockedAccountId }),
      b2.getKeyLastUsed(),
      b2.listBuckets({ customerId: lockedCustomerId, accountId: lockedAccountId }),
    ])
      .then(([{ keys }, { lastUsed }, { buckets }]) => {
        setKeys(keys);
        setLastUsed(lastUsed);
        setBucketStatusMap(new Map(
          buckets.map((bk) => [bk.bucketId, bk.accessLogging || { status: 'not_configured' }])
        ));
        setLoading(false);
      });
  }, [lockedCustomerId, lockedAccountId]);

  if (loading) return <LoadingState label="Listing application keys via b2_list_keys" />;

  const counts = keys.reduce((acc, k) => { acc[k.posture] = (acc[k.posture] || 0) + 1; return acc; }, {});
  const tabsWithCount = [
    { ...POSTURE_TABS[0], count: keys.length },
    ...POSTURE_TABS.slice(1).map((t) => ({ ...t, count: counts[t.id] || 0 })),
  ];
  const filtered = tab === 'all' ? keys : keys.filter((k) => k.posture === tab);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Security"
        title="Application keys & security posture"
        subtitle="Application keys are managed via the B2 Native API (b2_list_keys / b2_create_key). Each key can be scoped to specific buckets, capabilities, a name prefix, and an optional expirationTimestamp. The secret applicationKey value is returned ONCE on creation and never again — store it immediately."
        actions={<Tag variant="info">{keys.length} keys</Tag>}
      />

      {/* Posture summary */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Total keys" value={keys.length} source="api" icon={<KeyRound size={14} />} accent="violet" />
        <MetricCard
          label="Healthy"
          value={counts.good || 0}
          source="derived"
          icon={<ShieldCheck size={14} />}
          accent="green"
        />
        <MetricCard
          label="Need attention"
          value={(counts.attention || 0) + (counts.risk || 0)}
          source="derived"
          icon={<ShieldAlert size={14} />}
          accent="amber"
        />
        <MetricCard
          label="Expired"
          value={counts.expired || 0}
          source="derived"
          icon={<Calendar size={14} />}
          accent="red"
        />
      </div>

      {/* Posture cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PostureCard
          title="Bucket-scoped keys"
          stat={`${keys.filter((k) => k.bucketIds.length > 0).length} / ${keys.length}`}
          desc="Keys restricted to one or more bucketIds limit blast radius — strongly recommended over account-wide master keys."
          icon={<Shield size={18} />}
          tone="green"
        />
        <PostureCard
          title="Prefix-restricted keys"
          stat={`${keys.filter((k) => k.namePrefix).length} / ${keys.length}`}
          desc="namePrefix narrows access to a subtree (e.g. tenants/acme/), enabling per-tenant scoping inside a shared bucket."
          tone="violet"
          icon={<Shield size={18} />}
        />
        <PostureCard
          title="Keys without expiry"
          stat={`${keys.filter((k) => !k.expirationTimestamp).length}`}
          desc="Long-lived keys are convenient but increase risk. Set validDurationInSeconds on b2_create_key and rotate."
          tone={keys.filter((k) => !k.expirationTimestamp).length > 0 ? 'amber' : 'green'}
          icon={<Calendar size={18} />}
        />
      </div>

      <Card padding="p-0">
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-4">
          <Tabs tabs={tabsWithCount} value={tab} onChange={setTab} />
          <SourceBadge source="api" />
        </div>
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Key</TH>
              {!lockedCustomerId && <TH>Customer</TH>}
              <TH>Scope</TH>
              <TH>Capabilities</TH>
              <TH>Expires</TH>
              <TH>Last used</TH>
              <TH>Log coverage</TH>
              <TH>Posture</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((k) => {
              const cust = CUSTOMERS.find((c) => c.id === k.customerId);
              const Posture = POSTURE_STYLES[k.posture];
              const coverage = deriveKeyCoverage(k, bucketStatusMap);
              const { availability, label: coverageLabel, detail } = coverageToAvailability(coverage);
              const badge = coverageStatusBadge(coverage.overallStatus);
              const badgeToneClasses = {
                green: 'bg-accent-green/15 text-accent-green ring-accent-green/30',
                amber: 'bg-accent-amber/15 text-accent-amber ring-accent-amber/30',
                red:   'bg-bb-red/15 text-bb-red ring-bb-red/30',
                muted: 'bg-ink-700/50 text-ink-400 ring-ink-600/30',
              }[badge.tone];
              return (
                <TR key={k.applicationKeyId} onClick={() => navigate('key-detail', { keyId: k.applicationKeyId })}>
                  <TD>
                    <div className="font-mono text-[12px] text-ink-100">{k.keyName}</div>
                    <div className="font-mono text-[10.5px] text-ink-400">{k.applicationKeyId}</div>
                  </TD>
                  {!lockedCustomerId && <TD className="text-ink-300">{cust?.name || '—'}</TD>}
                  <TD>
                    <div className="text-xs text-ink-200">{k.bucketName}</div>
                    {k.namePrefix && (
                      <div className="font-mono text-[10.5px] text-accent-violet">prefix: {k.namePrefix}</div>
                    )}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {k.capabilities.slice(0, 3).map((c) => (
                        <Tag key={c} variant={c.startsWith('write') || c.startsWith('delete') ? 'warn' : 'info'}>{c}</Tag>
                      ))}
                      {k.capabilities.length > 3 && <Tag>+{k.capabilities.length - 3}</Tag>}
                    </div>
                  </TD>
                  <TD className="text-xs">
                    {k.expirationDate ? (
                      <span className={k.posture === 'expired' ? 'text-bb-red' : 'text-ink-200'}>{k.expirationDate}</span>
                    ) : (
                      <Tag variant="warn">no expiry</Tag>
                    )}
                  </TD>
                  <TD className="text-[11.5px] text-ink-300">
                    <LastUsedCell ts={lastUsed.get(k.applicationKeyId)} />
                  </TD>
                  <TD>
                    <span
                      title={coverageLabel}
                      className={'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset cursor-help ' + badgeToneClasses}
                    >
                      {badge.text}
                    </span>
                  </TD>
                  <TD>
                    <span
                      title={Posture.desc}
                      className={
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset cursor-help ' +
                        Posture.bg + ' ' + Posture.color + ' ' + Posture.ring
                      }
                    >
                      <Posture.icon size={11} /> {Posture.label}
                    </span>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      {/* Least privilege examples */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Least-privilege key example"
            subtitle="Create a tenant-scoped read/write key inside one bucket, restricted to a prefix"
            icon={<Code2 size={16} />}
          />
          <CodeBlock>
{`POST /b2api/v4/b2_create_key
{
  "accountId": "7f3a91d2c4b8",
  "keyName": "lumora-checkpoint-writer-prod",
  "bucketIds": ["4a8b1d3f7c2e9a0b6d4e3f51"],
  "namePrefix": "checkpoints/",
  "capabilities": ["writeFiles", "readFiles", "listFiles"],
  "validDurationInSeconds": 7776000
}`}
          </CodeBlock>
        </Card>
        <Card>
          <CardHeader
            title="What NOT to do"
            subtitle="Master-equivalent capabilities on a key with no expiry — broad blast radius"
            icon={<ShieldAlert size={16} />}
          />
          <CodeBlock>
{`POST /b2api/v4/b2_create_key
{
  "accountId": "7f3a91d2c4b8",
  "keyName": "boreal-genomics-master",
  "bucketIds": [],          // account-wide
  "capabilities": [
    "listBuckets","writeFiles","readFiles","listFiles",
    "deleteFiles","deleteBuckets","writeBucketInfo"
  ]
  // no validDurationInSeconds = never expires
}`}
          </CodeBlock>
        </Card>
      </div>

      {/* Event Notifications — real path to per-event activity */}
      <Card>
        <CardHeader
          title="Per-event activity · Backblaze Event Notifications"
          subtitle="Backblaze B2 supports Bucket Access Logs for per-request bucket activity, but they are not enabled by default and are delivered asynchronously on a best-effort basis. For near-real-time object-level events, configure B2 Event Notifications on your bucket; B2 can POST a JSON webhook to your HTTPS endpoint for supported object-created, object-deleted, and hide-marker-created events. Event Notifications do not cover object downloads and use at-least-once delivery."
          icon={<Bell size={16} />}
          action={
            <a
              href="https://www.backblaze.com/docs/cloud-storage-event-notifications"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs text-ink-200 hover:bg-ink-800"
            >
              <ExternalLink size={12} /> Open docs
            </a>
          }
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-300">Configure (per-bucket)</h4>
            <CodeBlock>
{`POST /b2api/v4/b2_set_bucket_notification_rules
{
  "bucketId": "4a8b1d3f7c2e9a0b6d4e3f51",
  "eventNotificationRules": [
    {
      "name": "checkpoint-uploads",
      "eventTypes": [ "b2:ObjectCreated:*" ],
      "objectNamePrefix": "checkpoints/",
      "isEnabled": true,
      "targetConfiguration": {
        "targetType": "webhook",
        "url": "https://events.kevinco.cloud/b2",
        "hmacSha256SigningSecret": "<your-shared-secret>"
      }
    }
  ]
}`}
            </CodeBlock>
          </div>
          <div>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-300">Sample webhook payload</h4>
            <CodeBlock>
{`POST https://events.kevinco.cloud/b2
X-Bz-Event-Notification-Signature-Sha256: <hmac>
{
  "events": [{
    "accountId": "7f3a91d2c4b8",
    "bucketId": "4a8b1d3f7c2e9a0b6d4e3f51",
    "bucketName": "lumora-training-checkpoints",
    "eventType": "b2:ObjectCreated:Upload",
    "eventTimestamp": 1745609648000,
    "eventVersion": 1,
    "matchedRuleName": "checkpoint-uploads",
    "objectName": "checkpoints/llama3-70b-step-58200.pt",
    "objectSize": 142817392640,
    "objectVersionId": "4_z..._d20260425_m191408"
  }]
}`}
            </CodeBlock>
          </div>
        </div>
        <div className="mt-4 rounded-md bg-ink-900/60 p-3 text-[11.5px] leading-relaxed text-ink-300 ring-1 ring-ink-700">
          <strong className="text-ink-100">How this would feed the dashboard:</strong> stand up a small webhook receiver, persist events to your DB, and render them here as the per-event audit feed. The Customer detail and Bucket detail pages would then show real `b2:ObjectCreated:*`, `b2:ObjectDeleted:*`, and `b2:HideMarkerCreated:*` records instead of the CSV-derived daily aggregates.
        </div>
      </Card>
    </div>
  );
}

function CodeBlock({ children }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-ink-950/80 p-3 text-[11.5px] leading-relaxed text-ink-200 ring-1 ring-ink-700">
      <code>{children}</code>
    </pre>
  );
}

// Renders "last used" — derived from Bucket Access Logs, never from b2_list_keys.
export function LastUsedCell({ ts, withBadge = true }) {
  if (!ts) {
    return (
      <span title="No access log records for this key. Either access logging isn't enabled on its buckets, or the key truly hasn't been used in the retained log window." className="text-ink-400 cursor-help">
        — <span className="text-[9px] uppercase tracking-wider">no logs</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{relativeTime(ts)}</span>
      {withBadge && (
        <span title="Derived from Bucket Access Logs — b2_list_keys does not return any usage timestamp" className="rounded bg-accent-amber/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-accent-amber ring-1 ring-inset ring-accent-amber/30 cursor-help">
          log
        </span>
      )}
    </span>
  );
}

function PostureCard({ title, stat, desc, icon, tone = 'green' }) {
  const tones = {
    green: 'text-accent-green ring-accent-green/30 bg-accent-green/5',
    amber: 'text-accent-amber ring-accent-amber/30 bg-accent-amber/5',
    violet: 'text-accent-violet ring-accent-violet/30 bg-accent-violet/5',
    red: 'text-bb-red ring-bb-red/30 bg-bb-red/5',
  }[tone];
  return (
    <Card className={"ring-1 " + tones}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[10.5px] font-medium uppercase tracking-wider text-ink-300">{title}</div>
          <div className="mt-1 text-2xl font-semibold text-ink-100">{stat}</div>
        </div>
        <div className={"rounded-md p-1.5 ring-1 ring-inset " + tones}>{icon}</div>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-400">{desc}</p>
    </Card>
  );
}
