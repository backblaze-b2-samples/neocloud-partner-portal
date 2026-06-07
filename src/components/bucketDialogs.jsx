// Customer-admin self-service dialogs: edit/delete a bucket, create/delete an
// application key (all capabilities with least-privilege defaults + guardrails),
// and upload files. Every action is wired through src/api/b2Adapter.js so it
// works in both demo (in-memory) and live (server-proxied) mode.
//
// These are gated by the caller — render them only when canManage is true.
// CreateBucketDialog already lives in ./dialogs.jsx and is reused as-is.

import React, { useState, useRef, useMemo } from 'react';
import {
  CheckCircle2, AlertTriangle, Copy, Trash2, UploadCloud, KeyRound, ShieldAlert,
  ShieldCheck, Eye, EyeOff, File as FileIcon, X,
} from 'lucide-react';
import { Modal, ModalFooter } from './Modal.jsx';
import { Tag } from './ui.jsx';
import { useApp } from '../lib/AppContext.jsx';
import * as b2 from '../api/b2Adapter.js';
import { bytes } from '../lib/format.js';

// ── Local form primitives (kept private; mirror dialogs.jsx styling) ─────────
function Field({ label, placeholder, value, onChange, help, mono, required, type = 'text' }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-ink-200">
        {label} {required && <span className="text-bb-red">*</span>}
      </div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={'w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40 ' + (mono ? 'font-mono' : '')}
      />
      {help && <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{help}</p>}
    </label>
  );
}

function Select({ label, value, onChange, options, help }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-ink-200">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {help && <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{help}</p>}
    </label>
  );
}

function ErrorBanner({ message }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/5 px-3 py-2 text-xs text-bb-red">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{message}</span>
    </div>
  );
}

function PrimaryButton({ children, disabled, type = 'submit', danger, onClick }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={
        'inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-white shadow-glow disabled:opacity-50 ' +
        (danger ? 'bg-bb-red hover:bg-bb-redDim' : 'bg-bb-red hover:bg-bb-redDim')
      }
    >
      {children}
    </button>
  );
}

function CancelButton({ onClick }) {
  return (
    <button type="button" onClick={onClick} className="rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100">
      Cancel
    </button>
  );
}

function SuccessPanel({ title, desc, onAck }) {
  return (
    <div className="space-y-3 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent-green/15 text-accent-green ring-1 ring-accent-green/30">
        <CheckCircle2 size={20} />
      </div>
      <h4 className="text-sm font-semibold text-ink-100">{title}</h4>
      <p className="mx-auto max-w-md text-xs text-ink-400">{desc}</p>
      <ModalFooter>
        <button onClick={onAck} className="rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white hover:bg-bb-redDim">Done</button>
      </ModalFooter>
    </div>
  );
}

// =============================================================================
// Edit bucket — bucketType, default encryption, lifecycle rules (b2_update_bucket)
// =============================================================================
export function EditBucketDialog({ open, onClose, onSaved, bucket, accountId }) {
  const { isLive } = useApp();
  const [bucketType, setBucketType] = useState(bucket?.bucketType || 'allPrivate');
  const [encryption, setEncryption] = useState(bucket?.encryption || 'SSE-B2');
  const [rules, setRules] = useState(() =>
    (bucket?.lifecycleRules || []).map((r) => ({
      fileNamePrefix: r.fileNamePrefix || '',
      daysFromUploadingToHiding: r.daysFromUploadingToHiding ?? '',
      daysFromHidingToDeleting: r.daysFromHidingToDeleting ?? '',
    }))
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  function addRule() {
    setRules((rs) => [...rs, { fileNamePrefix: '', daysFromUploadingToHiding: '', daysFromHidingToDeleting: '' }]);
  }
  function removeRule(i) { setRules((rs) => rs.filter((_, idx) => idx !== i)); }
  function patchRule(i, patch) { setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r))); }

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const lifecycleRules = rules.map((r) => ({
      fileNamePrefix: r.fileNamePrefix,
      daysFromUploadingToHiding: r.daysFromUploadingToHiding === '' ? null : Number(r.daysFromUploadingToHiding),
      daysFromHidingToDeleting: r.daysFromHidingToDeleting === '' ? null : Number(r.daysFromHidingToDeleting),
    }));
    try {
      const updated = await b2.updateBucket({
        accountId,
        bucketId: bucket.bucketId,
        bucketType,
        encryption,
        lifecycleRules,
      });
      setSaved(true);
      onSaved?.(updated);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit bucket · ${bucket?.bucketName}`}
      subtitle={isLive ? 'Live mode — calls b2_update_bucket on your sub-account.' : 'Demo mode — updates a local-only bucket record.'}
      size="lg"
    >
      {saved ? (
        <SuccessPanel title="Bucket updated" desc={`${bucket?.bucketName} now reflects your changes.`} onAck={onClose} />
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="Access"
              value={bucketType}
              onChange={setBucketType}
              options={[
                { value: 'allPrivate', label: 'allPrivate (recommended)' },
                { value: 'allPublic', label: 'allPublic (objects readable without auth)' },
              ]}
              help={bucketType === 'allPublic' ? 'Anyone with an object URL can read it — use with care.' : undefined}
            />
            <Select
              label="Default encryption (SSE)"
              value={encryption}
              onChange={setEncryption}
              options={[
                { value: 'SSE-B2', label: 'SSE-B2 (Backblaze-managed AES-256)' },
                { value: 'none', label: 'None' },
              ]}
              help="Applies to new uploads. Existing objects keep the encryption they were written with."
            />
          </div>

          <div className="space-y-2 rounded-md border border-ink-700 bg-ink-900/60 p-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">Lifecycle rules</p>
              <button type="button" onClick={addRule} className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800">+ Add rule</button>
            </div>
            <p className="text-[11px] text-ink-400">B2 lifecycle rules only <strong>hide</strong> and <strong>delete</strong> files on a schedule — there is no transition to a colder tier.</p>
            {rules.length === 0 && <p className="py-1 text-[11px] text-ink-500">No lifecycle rules. Files persist until deleted.</p>}
            {rules.map((r, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 rounded-md bg-ink-900/60 p-2 ring-1 ring-ink-700 sm:grid-cols-[1fr_auto_auto_auto]">
                <input
                  value={r.fileNamePrefix}
                  onChange={(e) => patchRule(i, { fileNamePrefix: e.target.value })}
                  placeholder="prefix/ (blank = all files)"
                  className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[11px] text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none"
                />
                <input
                  value={r.daysFromUploadingToHiding}
                  onChange={(e) => patchRule(i, { daysFromUploadingToHiding: e.target.value.replace(/\D/g, '') })}
                  placeholder="hide (days)"
                  className="w-28 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[11px] text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none"
                />
                <input
                  value={r.daysFromHidingToDeleting}
                  onChange={(e) => patchRule(i, { daysFromHidingToDeleting: e.target.value.replace(/\D/g, '') })}
                  placeholder="delete (days)"
                  className="w-28 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[11px] text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none"
                />
                <button type="button" onClick={() => removeRule(i)} className="grid place-items-center rounded-md px-2 text-ink-400 hover:bg-ink-800 hover:text-bb-red" title="Remove rule">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>

          {error && <ErrorBanner message={error} />}

          <ModalFooter>
            <CancelButton onClick={onClose} />
            <PrimaryButton disabled={submitting}>{submitting ? 'Saving…' : 'Save changes'}</PrimaryButton>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

// =============================================================================
// Delete bucket — typed confirmation (B2 requires the bucket be empty)
// =============================================================================
export function DeleteBucketDialog({ open, onClose, onDeleted, bucket, accountId }) {
  const { isLive } = useApp();
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const match = confirm.trim() === bucket?.bucketName;

  async function submit(e) {
    e.preventDefault();
    if (!match) return;
    setSubmitting(true);
    setError(null);
    try {
      await b2.deleteBucket({ accountId, bucketId: bucket.bucketId });
      onDeleted?.(bucket);
      onClose();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete bucket" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-bb-red/30 bg-bb-red/5 p-3 text-xs text-bb-red">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            This permanently deletes <span className="font-mono">{bucket?.bucketName}</span>. The bucket
            must be <strong>empty</strong> first — B2 rejects deletion of a bucket that still contains files.
          </div>
        </div>
        <Field
          label={<>Type <span className="font-mono">{bucket?.bucketName}</span> to confirm</>}
          value={confirm}
          onChange={setConfirm}
          placeholder={bucket?.bucketName}
          mono
        />
        {error && <ErrorBanner message={error} />}
        <ModalFooter>
          <CancelButton onClick={onClose} />
          <button
            type="submit"
            disabled={!match || submitting}
            className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white hover:bg-bb-redDim disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 size={12} /> {submitting ? 'Deleting…' : 'Delete bucket'}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

// =============================================================================
// Application key capabilities — grouped, with least-privilege defaults and
// danger flags. The full B2 capability surface, organized for humans.
// =============================================================================
const CAP_GROUPS = [
  {
    group: 'Read & list', tone: 'info',
    caps: [
      { id: 'listBuckets', label: 'listBuckets' },
      { id: 'listAllBucketNames', label: 'listAllBucketNames' },
      { id: 'readBuckets', label: 'readBuckets' },
      { id: 'listFiles', label: 'listFiles' },
      { id: 'readFiles', label: 'readFiles' },
      { id: 'shareFiles', label: 'shareFiles' },
      { id: 'listKeys', label: 'listKeys' },
      { id: 'readBucketEncryption', label: 'readBucketEncryption' },
      { id: 'readBucketRetentions', label: 'readBucketRetentions' },
      { id: 'readBucketReplications', label: 'readBucketReplications' },
      { id: 'readBucketNotifications', label: 'readBucketNotifications' },
      { id: 'readBucketLogging', label: 'readBucketLogging' },
      { id: 'readFileRetentions', label: 'readFileRetentions' },
      { id: 'readFileLegalHolds', label: 'readFileLegalHolds' },
    ],
  },
  {
    group: 'Write', tone: 'warn',
    caps: [
      { id: 'writeFiles', label: 'writeFiles' },
      { id: 'writeBucketEncryption', label: 'writeBucketEncryption' },
      { id: 'writeBucketRetentions', label: 'writeBucketRetentions' },
      { id: 'writeBucketReplications', label: 'writeBucketReplications' },
      { id: 'writeBucketNotifications', label: 'writeBucketNotifications' },
      { id: 'writeBucketLogging', label: 'writeBucketLogging' },
      { id: 'writeFileRetentions', label: 'writeFileRetentions' },
      { id: 'writeFileLegalHolds', label: 'writeFileLegalHolds' },
    ],
  },
  {
    group: 'Delete & bucket-admin', tone: 'danger',
    caps: [
      { id: 'deleteFiles', label: 'deleteFiles', danger: true },
      { id: 'writeBuckets', label: 'writeBuckets', danger: true },
      { id: 'deleteBuckets', label: 'deleteBuckets', danger: true },
      { id: 'writeKeys', label: 'writeKeys', danger: true },
      { id: 'deleteKeys', label: 'deleteKeys', danger: true },
      { id: 'bypassGovernance', label: 'bypassGovernance', danger: true },
    ],
  },
];
const ALL_CAPS = CAP_GROUPS.flatMap((g) => g.caps);
const DANGER_CAPS = new Set(ALL_CAPS.filter((c) => c.danger).map((c) => c.id));
// Least-privilege default: read + list + write objects in one bucket.
const DEFAULT_CAPS = ['listBuckets', 'listFiles', 'readFiles', 'writeFiles'];

const EXPIRY_OPTIONS = [
  { value: '604800', label: '7 days (recommended)' },
  { value: '2592000', label: '30 days' },
  { value: '7776000', label: '90 days' },
  { value: '31536000', label: '1 year' },
  { value: '', label: 'Never expires (not recommended)' },
];

// =============================================================================
// Create application key — full capability surface, guardrails, reveal-once
// =============================================================================
export function CreateKeyDialog({ open, onClose, onCreated, accountId, customerId, buckets = [] }) {
  const { isLive } = useApp();
  const [keyName, setKeyName] = useState('');
  // v4 Multi-Bucket Application Keys: a key may be scoped to one OR MORE buckets
  // (bucketIds array). Empty = account-wide. Default to the first bucket as a
  // least-privilege starting point.
  const [bucketIds, setBucketIds] = useState(buckets[0] ? [buckets[0].bucketId] : []);
  const [namePrefix, setNamePrefix] = useState('');
  const [validDuration, setValidDuration] = useState('604800');
  const [caps, setCaps] = useState(new Set(DEFAULT_CAPS));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null); // holds the secret, shown once
  const [revealed, setRevealed] = useState(false);

  function toggleCap(id) {
    setCaps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function applyPreset(ids) { setCaps(new Set(ids)); }
  function toggleBucket(id) {
    setBucketIds((prev) => (prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id]));
  }

  const selectedDanger = [...caps].filter((c) => DANGER_CAPS.has(c));
  const bucketScoped = bucketIds.length > 0;
  const hasExpiry = validDuration !== '';
  // Mirror normalizeApiKey posture logic for a live preview.
  const posture = selectedDanger.length > 0 && !hasExpiry ? 'risk'
    : (!bucketScoped || !hasExpiry || selectedDanger.length > 0) ? 'attention'
    : 'good';
  const postureStyle = {
    good: { Icon: ShieldCheck, cls: 'text-accent-green ring-accent-green/30 bg-accent-green/5', label: 'Healthy' },
    attention: { Icon: ShieldAlert, cls: 'text-accent-amber ring-accent-amber/30 bg-accent-amber/5', label: 'Watch' },
    risk: { Icon: ShieldAlert, cls: 'text-bb-red ring-bb-red/30 bg-bb-red/5', label: 'At risk' },
  }[posture];

  async function submit(e) {
    e.preventDefault();
    if (!keyName.trim()) return setError('Key name is required.');
    if (caps.size === 0) return setError('Select at least one capability.');
    setSubmitting(true);
    setError(null);
    try {
      const result = await b2.createApplicationKey({
        accountId,
        customerId,
        keyName: keyName.trim(),
        capabilities: [...caps],
        bucketIds,
        namePrefix: namePrefix || undefined,
        validDurationInSeconds: validDuration ? Number(validDuration) : undefined,
      });
      setCreated(result);
      onCreated?.(result);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSubmitting(false);
    }
  }

  const secret = created?.applicationKey;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create application key"
      subtitle={isLive ? 'Live mode — calls b2_create_key on your sub-account. The secret is shown once.' : 'Demo mode — generates a placeholder key (not usable against B2).'}
      size="lg"
    >
      {created ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border border-accent-green/30 bg-accent-green/5 p-3 text-xs text-accent-green">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            <div>Key <span className="font-mono">{created.keyName}</span> created. Copy the secret now — <strong>B2 never returns it again.</strong></div>
          </div>
          <SecretRow label="keyID" value={created.applicationKeyId} revealed />
          <SecretRow label="applicationKey (secret)" value={secret} revealed={revealed} onReveal={() => setRevealed(true)} />
          <ModalFooter>
            <PrimaryButton type="button" onClick={onClose}>Done — I've stored the secret</PrimaryButton>
          </ModalFooter>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Key name" placeholder="checkpoint-writer-prod" value={keyName} onChange={setKeyName} mono required
            help="A human label returned by b2_list_keys. Not a security boundary." />

          {/* Bucket scope — v4 Multi-Bucket Application Key: select one or more */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <div className="text-xs font-medium text-ink-200">Bucket scope</div>
              <div className="flex gap-1.5">
                <PresetButton onClick={() => setBucketIds(buckets.map((b) => b.bucketId))}>Select all</PresetButton>
                <PresetButton onClick={() => setBucketIds([])}>Account-wide</PresetButton>
              </div>
            </div>
            <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-ink-700 bg-ink-900 p-2">
              {buckets.length === 0 && (
                <p className="px-1 py-1 text-[11px] text-ink-500">No buckets in this account — the key will be account-wide.</p>
              )}
              {buckets.map((b) => {
                const on = bucketIds.includes(b.bucketId);
                return (
                  <label key={b.bucketId} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-ink-850">
                    <input type="checkbox" checked={on} onChange={() => toggleBucket(b.bucketId)} className="accent-bb-red" />
                    <span className="truncate font-mono text-ink-100">{b.bucketName}</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
              {bucketScoped
                ? `Scoped to ${bucketIds.length} bucket${bucketIds.length === 1 ? '' : 's'} — limits blast radius (recommended). v4 keys may span multiple buckets.`
                : '⚠ No buckets selected → account-wide key (can touch every bucket). Prefer scoping to specific buckets.'}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="Expiration"
              value={validDuration}
              onChange={setValidDuration}
              options={EXPIRY_OPTIONS}
              help={hasExpiry ? undefined : 'Long-lived keys increase risk if leaked.'}
            />
            <Field label="Name prefix (optional)" placeholder="tenants/acme/" value={namePrefix} onChange={setNamePrefix} mono
              help="Restricts the key to object names starting with this prefix." />
          </div>

          {/* Capabilities */}
          <div className="space-y-3 rounded-md border border-ink-700 bg-ink-900/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">Capabilities ({caps.size})</p>
              <div className="flex flex-wrap gap-1.5">
                <PresetButton onClick={() => applyPreset(['listBuckets', 'listFiles', 'readFiles'])}>Read-only</PresetButton>
                <PresetButton onClick={() => applyPreset(DEFAULT_CAPS)}>Read + write</PresetButton>
                <PresetButton onClick={() => applyPreset(ALL_CAPS.map((c) => c.id))}>Everything</PresetButton>
                <PresetButton onClick={() => applyPreset([])}>Clear</PresetButton>
              </div>
            </div>
            {CAP_GROUPS.map((g) => (
              <div key={g.group}>
                <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-400">{g.group}</div>
                <div className="flex flex-wrap gap-1.5">
                  {g.caps.map((c) => {
                    const on = caps.has(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleCap(c.id)}
                        className={
                          'inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] transition ' +
                          (on
                            ? (c.danger
                                ? 'border-bb-red/50 bg-bb-red/15 text-bb-red'
                                : 'border-accent-teal/40 bg-accent-teal/10 text-accent-teal')
                            : 'border-ink-700 bg-ink-900 text-ink-400 hover:text-ink-200')
                        }
                      >
                        {c.danger && <ShieldAlert size={10} />}
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Live posture preview */}
          <div className={'flex items-center justify-between gap-3 rounded-md px-3 py-2 text-xs ring-1 ring-inset ' + postureStyle.cls}>
            <span className="inline-flex items-center gap-1.5 font-medium">
              <postureStyle.Icon size={13} /> Posture preview: {postureStyle.label}
            </span>
            <span className="text-[11px] opacity-80">
              {bucketScoped ? 'bucket-scoped' : 'account-wide'} · {hasExpiry ? 'expires' : 'no expiry'}
              {selectedDanger.length > 0 && ` · ${selectedDanger.length} dangerous cap${selectedDanger.length === 1 ? '' : 's'}`}
            </span>
          </div>

          {selectedDanger.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-accent-amber/30 bg-accent-amber/5 px-3 py-2 text-[11px] text-accent-amber">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                This key includes master-equivalent capabilities (<span className="font-mono">{selectedDanger.join(', ')}</span>).
                Pair them with a short expiry and a single bucket scope, and rotate often.
              </span>
            </div>
          )}

          {error && <ErrorBanner message={error} />}

          <ModalFooter>
            <CancelButton onClick={onClose} />
            <PrimaryButton disabled={submitting}><KeyRound size={12} /> {submitting ? 'Creating…' : 'Create key'}</PrimaryButton>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

function PresetButton({ children, onClick }) {
  return (
    <button type="button" onClick={onClick} className="rounded-md border border-ink-700 bg-ink-850 px-2 py-0.5 text-[10.5px] text-ink-300 hover:bg-ink-800 hover:text-ink-100">
      {children}
    </button>
  );
}

function SecretRow({ label, value, revealed, onReveal }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(value || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-400">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-ink-700 bg-ink-950/80 px-3 py-2 font-mono text-[12px] text-ink-100">
          {revealed ? (value || '—') : '•'.repeat(24)}
        </code>
        {!revealed && onReveal && (
          <button type="button" onClick={onReveal} className="grid h-9 w-9 place-items-center rounded-md border border-ink-700 bg-ink-850 text-ink-300 hover:text-ink-100" title="Reveal">
            <Eye size={14} />
          </button>
        )}
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-2 text-[11px] text-ink-200 hover:bg-ink-800">
          <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Delete application key — confirm + revoke (b2_delete_key)
// =============================================================================
export function DeleteKeyDialog({ open, onClose, onDeleted, apiKey, accountId }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      await b2.deleteApplicationKey({ accountId, applicationKeyId: apiKey.applicationKeyId });
      onDeleted?.(apiKey);
      onClose();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete application key" size="sm">
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-bb-red/30 bg-bb-red/5 p-3 text-xs text-bb-red">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            Revoking <span className="font-mono">{apiKey?.keyName}</span> (<span className="font-mono">{apiKey?.applicationKeyId}</span>) is
            immediate and permanent. Any application still using it will start receiving auth errors.
          </div>
        </div>
        {error && <ErrorBanner message={error} />}
        <ModalFooter>
          <CancelButton onClick={onClose} />
          <button
            type="button"
            onClick={confirm}
            disabled={submitting}
            className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white hover:bg-bb-redDim disabled:opacity-40"
          >
            <Trash2 size={12} /> {submitting ? 'Revoking…' : 'Revoke key'}
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}

// =============================================================================
// Rotate application key — create a replacement with identical scope + caps,
// reveal its secret once, then revoke the old key. (b2_create_key + b2_delete_key)
// =============================================================================
export function RotateKeyDialog({ open, onClose, onRotated, apiKey, accountId }) {
  const { isLive } = useApp();
  const [validDuration, setValidDuration] = useState('604800');
  const [phase, setPhase] = useState('confirm'); // confirm | working | done | error
  const [created, setCreated] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState(null);
  const [revokeWarning, setRevokeWarning] = useState(null);

  // v4 keys carry a bucketIds array — preserve the full scope on rotation.
  const scopeBucketIds = apiKey?.bucketIds || [];

  async function rotate() {
    setPhase('working');
    setError(null);
    setRevokeWarning(null);
    // Step 1: create the replacement. If this fails, nothing has changed.
    let replacement;
    try {
      replacement = await b2.createApplicationKey({
        accountId,
        customerId: apiKey.customerId,
        keyName: apiKey.keyName,
        capabilities: apiKey.capabilities,
        bucketIds: scopeBucketIds,
        namePrefix: apiKey.namePrefix || undefined,
        validDurationInSeconds: validDuration ? Number(validDuration) : undefined,
      });
    } catch (err) {
      setError('Could not create the replacement key: ' + String(err.message || err));
      setPhase('error');
      return;
    }
    // The new key (and its one-time secret) now exists — surface it no matter
    // what happens next, so it's never lost.
    setCreated(replacement);
    // Step 2: revoke the old key. If THIS fails, both keys are live — warn
    // loudly so the operator revokes the old one manually.
    try {
      await b2.deleteApplicationKey({ accountId, applicationKeyId: apiKey.applicationKeyId });
    } catch (err) {
      setRevokeWarning(`The new key was created, but the OLD key (${apiKey.applicationKeyId}) could NOT be revoked: ${String(err.message || err)}. Revoke it manually.`);
    }
    setPhase('done');
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Rotate key · ${apiKey?.keyName}`}
      subtitle={isLive ? 'Creates a replacement key, then revokes this one.' : 'Demo mode — simulated rotation.'}
      size="lg"
    >
      {phase === 'done' && created ? (
        <div className="space-y-4">
          {revokeWarning ? (
            <div className="flex items-start gap-3 rounded-md border border-bb-red/30 bg-bb-red/5 p-3 text-xs text-bb-red">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>{revokeWarning} Copy the new secret now — <strong>it won't be shown again.</strong></div>
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded-md border border-accent-green/30 bg-accent-green/5 p-3 text-xs text-accent-green">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              <div>Rotated. The old key has been revoked. Copy the new secret now — <strong>it won't be shown again.</strong></div>
            </div>
          )}
          <SecretRow label="new keyID" value={created.applicationKeyId} revealed />
          <SecretRow label="new applicationKey (secret)" value={created.applicationKey} revealed={revealed} onReveal={() => setRevealed(true)} />
          <ModalFooter>
            <PrimaryButton type="button" onClick={() => { onRotated?.(created); }}>Done</PrimaryButton>
          </ModalFooter>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border border-ink-700 bg-ink-900/60 p-3 text-xs text-ink-300">
            A new key named <span className="font-mono text-ink-100">{apiKey?.keyName}</span> will be created with the
            <strong className="text-ink-100"> same capabilities</strong>
            {scopeBucketIds.length > 0 ? ` and bucket scope (${scopeBucketIds.length} bucket${scopeBucketIds.length === 1 ? '' : 's'})` : ' (account-wide)'}
            {apiKey?.namePrefix ? <> and prefix <span className="font-mono text-ink-100">{apiKey.namePrefix}</span></> : ''}.
            Then this key (<span className="font-mono">{apiKey?.applicationKeyId}</span>) is revoked.
          </div>
          <Select label="New key expiration" value={validDuration} onChange={setValidDuration} options={EXPIRY_OPTIONS} />
          {error && <ErrorBanner message={error} />}
          <ModalFooter>
            <CancelButton onClick={onClose} />
            <PrimaryButton type="button" disabled={phase === 'working'} onClick={rotate}>
              {phase === 'working' ? 'Rotating…' : 'Rotate key'}
            </PrimaryButton>
          </ModalFooter>
        </div>
      )}
    </Modal>
  );
}

// =============================================================================
// File upload — drag/drop or picker, streamed with progress (per file)
// =============================================================================
export function FileUploadDialog({ open, onClose, onUploaded, accountId, bucket, region, activePrefix = '' }) {
  const { isLive } = useApp();
  const [prefix, setPrefix] = useState(activePrefix || '');
  const [items, setItems] = useState([]); // { file, status: 'pending'|'uploading'|'done'|'error', progress, error }
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  function addFiles(fileList) {
    const added = Array.from(fileList).map((file) => ({ file, status: 'pending', progress: 0, error: null }));
    setItems((prev) => [...prev, ...added]);
  }
  function removeItem(i) { setItems((prev) => prev.filter((_, idx) => idx !== i)); }

  async function uploadAll() {
    setBusy(true);
    for (let i = 0; i < items.length; i++) {
      if (items[i].status === 'done') continue;
      const { file } = items[i];
      const key = (prefix || '') + file.name;
      setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, status: 'uploading', progress: 0 } : it)));
      try {
        await b2.uploadFile({
          accountId,
          bucket: bucket.bucketName,
          region,
          key,
          bucketId: bucket.bucketId,
          file,
          contentType: file.type || 'application/octet-stream',
          onProgress: (p) => setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, progress: p } : it))),
        });
        setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, status: 'done', progress: 100 } : it)));
      } catch (err) {
        setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, status: 'error', error: String(err.message || err) } : it)));
      }
    }
    setBusy(false);
    onUploaded?.();
  }

  const allDone = items.length > 0 && items.every((it) => it.status === 'done');
  const canUpload = !!region && items.some((it) => it.status === 'pending' || it.status === 'error');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Upload to ${bucket?.bucketName}`}
      subtitle={isLive ? 'Streamed through the proxy to an S3 PUT — works on private buckets.' : 'Demo mode — simulated upload into the in-memory file list.'}
      size="lg"
    >
      <div className="space-y-4">
        {!region && (
          <ErrorBanner message="This bucket's region is unknown, so uploads can't be signed. Open it from the Storage list (which resolves the region) and try again." />
        )}

        <Field label="Destination prefix (folder)" placeholder="checkpoints/" value={prefix} onChange={setPrefix} mono
          help="Prepended to each file name. Blank uploads to the bucket root." />

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          className={
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition ' +
            (dragOver ? 'border-bb-red/60 bg-bb-red/5' : 'border-ink-700 bg-ink-900/40 hover:border-ink-600')
          }
        >
          <UploadCloud size={28} className="text-ink-400" />
          <div className="text-sm text-ink-200">Drop files here or <span className="text-bb-red">browse</span></div>
          <div className="text-[11px] text-ink-500">Multiple files supported · streamed individually</div>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </div>

        {items.length > 0 && (
          <div className="space-y-1.5">
            {items.map((it, i) => (
              <div key={i} className="rounded-md border border-ink-700 bg-ink-900/60 p-2.5">
                <div className="flex items-center gap-2">
                  <FileIcon size={13} className="shrink-0 text-ink-400" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-100">{(prefix || '') + it.file.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-400">{bytes(it.file.size)}</span>
                  {it.status === 'done' && <CheckCircle2 size={14} className="shrink-0 text-accent-green" />}
                  {it.status === 'error' && <AlertTriangle size={14} className="shrink-0 text-bb-red" />}
                  {(it.status === 'pending') && !busy && (
                    <button onClick={() => removeItem(i)} className="shrink-0 text-ink-500 hover:text-bb-red" title="Remove"><X size={13} /></button>
                  )}
                </div>
                {(it.status === 'uploading' || it.status === 'done') && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-800">
                    <div className="h-full rounded-full bg-bb-red transition-all" style={{ width: `${it.progress}%` }} />
                  </div>
                )}
                {it.status === 'error' && <div className="mt-1 text-[11px] text-bb-red">{it.error}</div>}
              </div>
            ))}
          </div>
        )}

        <ModalFooter>
          <CancelButton onClick={onClose} />
          {allDone ? (
            <PrimaryButton type="button" onClick={onClose}>Done</PrimaryButton>
          ) : (
            <button
              type="button"
              onClick={uploadAll}
              disabled={!canUpload || busy}
              className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <UploadCloud size={12} /> {busy ? 'Uploading…' : `Upload ${items.filter((it) => it.status !== 'done').length || ''}`.trim()}
            </button>
          )}
        </ModalFooter>
      </div>
    </Modal>
  );
}

// =============================================================================
// Small confirm dialog for deleting a single file
// =============================================================================
export function DeleteFileDialog({ open, onClose, onDeleted, file, bucket, region, accountId }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      await b2.deleteFile({ accountId, bucket: bucket.bucketName, region, key: file.fileName, bucketId: bucket.bucketId });
      onDeleted?.(file);
      onClose();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete file" size="sm">
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-bb-red/30 bg-bb-red/5 p-3 text-xs text-bb-red">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>Delete <span className="font-mono break-all">{file?.fileName}</span> from <span className="font-mono">{bucket?.bucketName}</span>? B2 keeps prior versions unless a lifecycle rule removes them.</div>
        </div>
        {!region && <ErrorBanner message="Region unknown — open the bucket from the Storage list so the region resolves." />}
        {error && <ErrorBanner message={error} />}
        <ModalFooter>
          <CancelButton onClick={onClose} />
          <button
            type="button"
            onClick={confirm}
            disabled={submitting || !region}
            className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white hover:bg-bb-redDim disabled:opacity-40"
          >
            <Trash2 size={12} /> {submitting ? 'Deleting…' : 'Delete file'}
          </button>
        </ModalFooter>
      </div>
    </Modal>
  );
}
