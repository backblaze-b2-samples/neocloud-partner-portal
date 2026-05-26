// CreateCustomerDialog, CreateBucketDialog, EditCustomerDialog,
// TerminateMemberDialog — wired through the same adapters so they work in
// both demo and live mode.

import React, { useState, useEffect } from 'react';
import { Modal, ModalFooter } from './Modal.jsx';
import { Tag, SourceBadge } from './ui.jsx';
import { REGIONS } from '../data/regions.js';
import { GROUPS } from '../data/groups.js';
import * as partner from '../api/partnerApi.js';
import * as b2 from '../api/b2Adapter.js';
import { useApp } from '../lib/AppContext.jsx';
import { CheckCircle2, AlertTriangle, DollarSign } from 'lucide-react';

// Standard Backblaze pricing (reference defaults when no override is set)
const STD_STORAGE_PER_GB  = 0.006;  // $/GB/month
const STD_DOWNLOAD_PER_GB = 0.01;   // $/GB egress

const PLAN_OPTIONS = [
  'Reseller — Tier 1',
  'Reseller — Tier 2',
  'Reseller — Tier 3',
  'Partner — Custom',
];

// =============================================================================
// Create Customer (sub-account)
// =============================================================================
export function CreateCustomerDialog({ open, onClose, onCreated, defaultGroupId }) {
  const { isLive } = useApp();
  const [form, setForm] = useState({
    name: '',
    contactEmail: '',
    industry: '',
    region: REGIONS[0].id,
    plan: 'Reseller — Tier 3',
    groupId: defaultGroupId || GROUPS[0].groupId,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);

  // Live groups — fetch from Partner API when dialog opens. Falls back to mock data.
  const [liveGroups, setLiveGroups] = useState(null); // null = not yet loaded
  useEffect(() => {
    if (!open) return;
    setLiveGroups(null);
    partner.listGroups()
      .then((data) => {
        const groups = data?.groups ?? data?.groupsList ?? [];
        if (groups.length > 0) {
          setLiveGroups(groups);
          const gid = defaultGroupId || groups[0].groupId;
          setForm((f) => ({ ...f, groupId: gid }));
        }
      })
      .catch(() => { /* stay on mock groups */ });
  }, [open, isLive, defaultGroupId]);

  const groupOptions = liveGroups
    ? liveGroups.map((g) => ({ value: g.groupId, label: g.groupName || g.groupId }))
    : GROUPS.map((g) => ({ value: g.groupId, label: g.groupName }));

  async function submit(e) {
    e.preventDefault();
    if (!form.name || !form.contactEmail) {
      setError('Name and contact email are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const newCust = await partner.createCustomer(form);
      setCreated(newCust);
      onCreated?.(newCust);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setForm({ name: '', contactEmail: '', industry: '', region: REGIONS[0].id, plan: 'Reseller — Tier 3', groupId: defaultGroupId || GROUPS[0].groupId });
    setCreated(null);
    setError(null);
    setLiveGroups(null);
  }

  return (
    <Modal
      open={open}
      onClose={() => { onClose(); setTimeout(reset, 200); }}
      title="Create new customer"
      subtitle={isLive ? 'Live mode — calls Partner API to provision a new sub-account.' : 'Demo mode — creates a local-only sub-account record.'}
    >
      {created ? (
        <SuccessPanel
          title={`Customer "${created.name}" created`}
          desc={`Account ID: ${created.accountId}. The sub-account now appears in the Groups and Customers views.`}
          onAck={() => { onClose(); setTimeout(reset, 200); }}
        />
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Customer name" placeholder="Lumora AI" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          <Field label="Contact email" type="email" placeholder="platform@lumora.ai" value={form.contactEmail} onChange={(v) => setForm({ ...form, contactEmail: v })} required />
          <Field label="Industry" placeholder="GPU Cloud / AI Inference" value={form.industry} onChange={(v) => setForm({ ...form, industry: v })} />
          <Select
            label={liveGroups === null ? 'Group (loading…)' : `Group${isLive ? ' · live' : ''}`}
            value={form.groupId}
            onChange={(v) => setForm({ ...form, groupId: v })}
            options={groupOptions}
            help="Sub-accounts are organized under partner Groups for billing rollup."
          />
          <Select
            label="Region"
            value={form.region}
            onChange={(v) => setForm({ ...form, region: v })}
            options={REGIONS.map((r) => ({ value: r.id, label: `${r.flag} ${r.code} · ${r.city}` }))}
            help="Region is set at sub-account creation and cannot be changed via API."
          />
          <Select
            label="Plan"
            value={form.plan}
            onChange={(v) => setForm({ ...form, plan: v })}
            options={PLAN_OPTIONS.map((v) => ({ value: v, label: v }))}
          />

          {error && <ErrorBanner message={error} />}

          <ModalFooter>
            <button type="button" onClick={onClose} className="rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100">Cancel</button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create customer'}
            </button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

// =============================================================================
// Edit Customer
// =============================================================================
export function EditCustomerDialog({ open, onClose, onSaved, customer }) {
  const { isLive } = useApp();

  // Live groups for the group selector
  const [liveGroups, setLiveGroups] = useState(null);
  useEffect(() => {
    if (!open) return;
    partner.listGroups()
      .then((data) => {
        const groups = data?.groups ?? data?.groupsList ?? [];
        if (groups.length > 0) setLiveGroups(groups);
      })
      .catch(() => {});
  }, [open, isLive]);

  const groupOptions = liveGroups
    ? liveGroups.map((g) => ({ value: g.groupId, label: g.groupName || g.groupId }))
    : GROUPS.map((g) => ({ value: g.groupId, label: g.groupName }));

  const [form, setForm] = useState({
    newEmail: '',
    display_name: '',
    industry: '',
    plan: '',
    groupId: '',
    price_per_gb_storage: '',
    price_per_gb_download: '',
    notes: '',
  });
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  // Load current metadata whenever the dialog opens
  useEffect(() => {
    if (!open || !customer) return;
    setMetaLoaded(false);
    setSaved(false);
    setError(null);
    partner.getCustomerMeta(customer.accountId)
      .then((meta) => {
        setForm({
          newEmail: '',
          display_name: meta?.display_name || customer.name || '',
          industry:     meta?.industry     || customer.industry || '',
          plan:         meta?.plan         || customer.plan     || PLAN_OPTIONS[2],
          groupId:      customer.groupId   || '',
          price_per_gb_storage:  meta?.price_per_gb_storage  != null ? String(meta.price_per_gb_storage)  : '',
          price_per_gb_download: meta?.price_per_gb_download != null ? String(meta.price_per_gb_download) : '',
          notes: meta?.notes || '',
        });
        setMetaLoaded(true);
      })
      .catch(() => {
        setForm({
          newEmail: '',
          display_name: customer.name     || '',
          industry:     customer.industry || '',
          plan:         customer.plan     || PLAN_OPTIONS[2],
          groupId:      customer.groupId  || '',
          price_per_gb_storage: '',
          price_per_gb_download: '',
          notes: '',
        });
        setMetaLoaded(true);
      });
  }, [open, customer]);

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // 1. Optional email update via Partner API (live mode only)
      if (isLive && form.newEmail.trim()) {
        await partner.updateMemberEmail(customer.accountId, form.newEmail.trim());
      }

      // 2. Save local metadata (always — demo and live)
      await partner.saveCustomerMeta(customer.accountId, {
        display_name:          form.display_name.trim() || null,
        industry:              form.industry.trim()     || null,
        plan:                  form.plan                || null,
        price_per_gb_storage:  form.price_per_gb_storage  ? Number(form.price_per_gb_storage)  : null,
        price_per_gb_download: form.price_per_gb_download ? Number(form.price_per_gb_download) : null,
        notes:                 form.notes.trim()        || null,
      });

      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    onClose();
    setTimeout(() => { setSaved(false); setError(null); }, 200);
  }

  const storagePrice  = form.price_per_gb_storage  ? Number(form.price_per_gb_storage)  : STD_STORAGE_PER_GB;
  const downloadPrice = form.price_per_gb_download ? Number(form.price_per_gb_download) : STD_DOWNLOAD_PER_GB;

  return (
    <Modal open={open} onClose={handleClose} title={`Edit: ${customer?.name || 'customer'}`} subtitle="Local metadata is saved to the control plane. Email changes call the B2 Partner API." size="lg">
      {saved ? (
        <SuccessPanel
          title="Customer updated"
          desc="Metadata saved. Email changed in B2 if a new address was provided."
          onAck={handleClose}
        />
      ) : !metaLoaded ? (
        <div className="py-10 text-center text-sm text-ink-400">Loading current settings…</div>
      ) : (
        <form onSubmit={submit} className="space-y-4">

          {/* B2 email update */}
          <div className="rounded-md border border-ink-700 bg-ink-900/60 p-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">
              B2 account email
              {!isLive && <span className="ml-1 normal-case font-normal text-ink-500"> — demo mode, no API call</span>}
            </p>
            <p className="text-[11px] text-ink-400">
              Current: <span className="font-mono text-ink-200">{customer?.contactEmail || '—'}</span>
            </p>
            <Field
              label="New email address"
              type="email"
              placeholder="Leave blank to keep current"
              value={form.newEmail}
              onChange={(v) => setForm({ ...form, newEmail: v })}
            />
          </div>

          {/* Local metadata */}
          <div className="rounded-md border border-ink-700 bg-ink-900/60 p-3 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">Local metadata</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="Display name"
                placeholder={customer?.name}
                value={form.display_name}
                onChange={(v) => setForm({ ...form, display_name: v })}
              />
              <Field
                label="Industry"
                placeholder="GPU Cloud / AI Inference"
                value={form.industry}
                onChange={(v) => setForm({ ...form, industry: v })}
              />
              <Select
                label="Plan"
                value={form.plan || PLAN_OPTIONS[2]}
                onChange={(v) => setForm({ ...form, plan: v })}
                options={PLAN_OPTIONS.map((v) => ({ value: v, label: v }))}
              />
              {/* Group is read-only — B2 Partner API does not support moving
                  members between groups. Re-assignment requires the web UI. */}
              <div className="block">
                <div className="mb-1 text-xs font-medium text-ink-200">Group <span className="font-normal text-ink-500">(read-only — moves require web UI)</span></div>
                <div className="w-full rounded-md border border-ink-700 bg-ink-900/40 px-3 py-2 text-sm font-mono text-ink-400 cursor-not-allowed">
                  {groupOptions.find(g => g.value === form.groupId)?.label || form.groupId || '—'}
                </div>
              </div>
            </div>
          </div>

          {/* Pricing overrides */}
          <div className="rounded-md border border-accent-teal/20 bg-accent-teal/5 p-3 space-y-3">
            <div className="flex items-center gap-1.5">
              <DollarSign size={12} className="text-accent-teal" />
              <p className="text-[11px] font-semibold uppercase tracking-wider text-accent-teal">
                Pricing overrides — profit tracking
              </p>
            </div>
            <p className="text-[11px] text-ink-400">
              Set the rates you charge this customer. Used to compute gross margin in the Billing tab. Leave blank to show standard Backblaze rates.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label={`Your storage rate ($/GB/mo) · std $${STD_STORAGE_PER_GB}`}
                placeholder={String(STD_STORAGE_PER_GB)}
                value={form.price_per_gb_storage}
                onChange={(v) => setForm({ ...form, price_per_gb_storage: v })}
                mono
              />
              <Field
                label={`Your download rate ($/GB) · std $${STD_DOWNLOAD_PER_GB}`}
                placeholder={String(STD_DOWNLOAD_PER_GB)}
                value={form.price_per_gb_download}
                onChange={(v) => setForm({ ...form, price_per_gb_download: v })}
                mono
              />
            </div>
            <div className="rounded-md bg-ink-900/60 px-3 py-2 text-[11px] text-ink-300 space-y-0.5">
              <p>
                Your rates → Storage: <span className="font-mono text-accent-teal">${storagePrice}/GB/mo</span>
                {' · '}Download: <span className="font-mono text-accent-teal">${downloadPrice}/GB</span>
              </p>
              <p className="text-ink-500">
                Backblaze COGS → Storage: $6.95/TB/mo · Download: $0.01/GB · Class A/B/C/D: free
              </p>
            </div>
          </div>

          {/* Admin notes */}
          <label className="block">
            <div className="mb-1 text-xs font-medium text-ink-200">Admin notes</div>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Internal notes visible only to admins…"
              rows={2}
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40 resize-none"
            />
          </label>

          {error && <ErrorBanner message={error} />}

          <ModalFooter>
            <button type="button" onClick={handleClose} className="rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100">Cancel</button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Save changes'}
            </button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

// =============================================================================
// Terminate Member
// =============================================================================
export function TerminateMemberDialog({ open, onClose, onTerminated, customer }) {
  const { isLive } = useApp();
  const [newEmail, setNewEmail]         = useState('');
  const [step, setStep]                 = useState('confirm'); // 'confirm' | 'progress' | 'done' | 'error'
  const [progressMsg, setProgressMsg]   = useState('');
  const [errorMsg, setErrorMsg]         = useState('');

  function reset() {
    setNewEmail('');
    setStep('confirm');
    setProgressMsg('');
    setErrorMsg('');
  }

  function handleClose() {
    onClose();
    setTimeout(reset, 200);
  }

  async function terminate() {
    setStep('progress');
    try {
      // b2_eject_group_member handles email update + eject in a single API call.
      setProgressMsg('Ejecting member via b2_eject_group_member…');
      await partner.removeGroupMember({
        accountId: customer.accountId,
        groupId:   customer.groupId,
        newEmail:  (isLive && newEmail.trim()) ? newEmail.trim() : undefined,
      });

      setStep('done');
      onTerminated?.();
    } catch (err) {
      setErrorMsg(String(err.message || err));
      setStep('error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Terminate customer"
      subtitle="Ejects the sub-account from the Partner group. Their B2 data remains intact."
    >
      {step === 'confirm' && (
        <div className="space-y-4">
          {/* Warning banner */}
          <div className="flex gap-3 rounded-md border border-bb-red/30 bg-bb-red/5 p-4">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-bb-red" />
            <div className="space-y-1.5 text-xs">
              <p className="font-semibold text-bb-red">This action cannot be undone via the API.</p>
              <p className="text-ink-300">
                Ejecting{' '}
                <span className="font-semibold text-ink-100">{customer?.name}</span>{' '}
                (account <span className="font-mono text-ink-200">{customer?.accountId}</span>) removes them from your Partner group and ends managed billing.
              </p>
              <p className="text-ink-400">
                Their B2 account, buckets, and data remain intact — the account transitions to the standalone tier. They will need to reset their password on next login.
              </p>
              <p className="font-medium text-accent-amber">
                ⚠ Once ejected, this member cannot be re-added to any group via the API. Re-invitation requires the Backblaze Group Management web UI.
              </p>
            </div>
          </div>

          {/* Optional email update */}
          <div className="rounded-md border border-ink-700 bg-ink-900/60 p-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">
              Optional: update email before ejecting
              {!isLive && <span className="ml-1 normal-case font-normal text-ink-500"> — demo mode</span>}
            </p>
            <p className="text-[11px] text-ink-400">
              Current: <span className="font-mono text-ink-200">{customer?.contactEmail || '—'}</span>
            </p>
            <Field
              label="New email (leave blank to keep current)"
              type="email"
              placeholder="offboarded@customer.example"
              value={newEmail}
              onChange={setNewEmail}
            />
          </div>

          <ModalFooter>
            <button type="button" onClick={handleClose} className="rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100">Cancel</button>
            <button
              type="button"
              onClick={terminate}
              className="inline-flex items-center gap-1.5 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim"
            >
              <AlertTriangle size={11} /> Terminate & eject
            </button>
          </ModalFooter>
        </div>
      )}

      {step === 'progress' && (
        <div className="py-10 text-center space-y-3">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-ink-700 border-t-bb-red" />
          <p className="text-sm text-ink-300">{progressMsg || 'Working…'}</p>
        </div>
      )}

      {step === 'done' && (
        <SuccessPanel
          title="Customer terminated"
          desc={`${customer?.name} has been ejected from the Partner group. Their standalone B2 account remains active.`}
          onAck={handleClose}
        />
      )}

      {step === 'error' && (
        <div className="space-y-4">
          <ErrorBanner message={errorMsg} />
          <ModalFooter>
            <button type="button" onClick={() => setStep('confirm')} className="rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100">
              Back
            </button>
            <button type="button" onClick={handleClose} className="rounded-md bg-bb-red px-3 py-1.5 text-xs text-white hover:bg-bb-redDim">
              Close
            </button>
          </ModalFooter>
        </div>
      )}
    </Modal>
  );
}

// =============================================================================
// Create Bucket
// =============================================================================
export function CreateBucketDialog({ open, onClose, onCreated, customer }) {
  const { isLive } = useApp();
  const [form, setForm] = useState({
    bucketName: '',
    bucketType: 'allPrivate',
    encryption: 'SSE-B2',
    objectLockEnabled: false,
    addLifecycle: false,
    lifecyclePrefix: '',
    daysToHide: '',
    daysToDelete: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!form.bucketName) return setError('Bucket name is required.');
    if (!/^[a-z0-9][a-z0-9-]{4,48}[a-z0-9]$/.test(form.bucketName)) {
      return setError('Bucket name must be 6–50 chars, lowercase letters / digits / dashes, starting and ending with a letter or digit.');
    }
    setSubmitting(true);
    setError(null);

    const lifecycleRules = form.addLifecycle ? [{
      fileNamePrefix: form.lifecyclePrefix,
      daysFromUploadingToHiding: form.daysToHide ? Number(form.daysToHide) : null,
      daysFromHidingToDeleting: form.daysToDelete ? Number(form.daysToDelete) : null,
    }] : [];

    try {
      const newBucket = await b2.createBucket({
        bucketName: form.bucketName,
        bucketType: form.bucketType,
        accountId: customer?.accountId,
        customerId: customer?.id,
        region: customer?.region,
        encryption: form.encryption,
        objectLockEnabled: form.objectLockEnabled,
        lifecycleRules,
      });
      setCreated(newBucket);
      onCreated?.(newBucket);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setForm({
      bucketName: '', bucketType: 'allPrivate', encryption: 'SSE-B2', objectLockEnabled: false,
      addLifecycle: false, lifecyclePrefix: '', daysToHide: '', daysToDelete: '',
    });
    setCreated(null);
    setError(null);
  }

  return (
    <Modal
      open={open}
      onClose={() => { onClose(); setTimeout(reset, 200); }}
      title={customer ? `Create bucket for ${customer.name}` : 'Create bucket'}
      subtitle={isLive ? "Live mode — calls b2_create_bucket on the customer's sub-account." : 'Demo mode — creates a local-only bucket record.'}
      size="lg"
    >
      {created ? (
        <SuccessPanel
          title={`Bucket "${created.bucketName}" created`}
          desc={`Bucket ID: ${created.bucketId}. Region: ${created.region}.`}
          onAck={() => { onClose(); setTimeout(reset, 200); }}
        />
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field
            label="Bucket name"
            placeholder="lumora-training-checkpoints"
            value={form.bucketName}
            onChange={(v) => setForm({ ...form, bucketName: v.toLowerCase() })}
            help="Globally unique within Backblaze. Lowercase letters, digits, dashes."
            mono
            required
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Select
              label="Access"
              value={form.bucketType}
              onChange={(v) => setForm({ ...form, bucketType: v })}
              options={[
                { value: 'allPrivate', label: 'allPrivate (recommended)' },
                { value: 'allPublic', label: 'allPublic (objects readable without auth)' },
              ]}
            />
            <Select
              label="Default encryption (SSE)"
              value={form.encryption}
              onChange={(v) => setForm({ ...form, encryption: v })}
              options={[
                { value: 'SSE-B2', label: 'SSE-B2 (Backblaze-managed AES-256)' },
                { value: 'SSE-C', label: 'SSE-C (customer-supplied key per request)' },
                { value: 'none', label: 'None' },
              ]}
              help={form.encryption === 'SSE-C' ? 'SSE-C: the encryption key must be provided on every upload and download request.' : undefined}
            />
          </div>

          <div className="space-y-2 rounded-md border border-ink-700 bg-ink-900/60 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">Versioning &amp; Object Lock</p>
            <p className="text-[11px] text-ink-400">
              B2 buckets are <strong className="text-ink-200">always versioned</strong> — every overwrite or delete creates a new version. This cannot be disabled.
            </p>
            <label className="flex items-start gap-2 text-xs text-ink-200 pt-1">
              <input
                type="checkbox"
                checked={form.objectLockEnabled}
                onChange={(e) => setForm({ ...form, objectLockEnabled: e.target.checked })}
                className="accent-bb-red mt-0.5"
              />
              <span>
                Enable Object Lock (WORM)
                <span className="ml-1 text-ink-400 font-normal">— sets <code className="font-mono text-ink-300">isObjectLockEnabled: true</code> at bucket creation. Cannot be disabled after creation. Governance / compliance retention modes are set per-object after upload.</span>
              </span>
            </label>
          </div>

          <label className="flex items-center gap-2 text-xs text-ink-200">
            <input
              type="checkbox"
              checked={form.addLifecycle}
              onChange={(e) => setForm({ ...form, addLifecycle: e.target.checked })}
              className="accent-bb-red"
            />
            Add a lifecycle rule (hide / delete files on a schedule)
          </label>

          {form.addLifecycle && (
            <div className="grid grid-cols-1 gap-4 rounded-md border border-ink-700 bg-ink-900/60 p-3 sm:grid-cols-3">
              <Field
                label="File name prefix"
                placeholder="checkpoints/"
                value={form.lifecyclePrefix}
                onChange={(v) => setForm({ ...form, lifecyclePrefix: v })}
                help="Empty = applies to all files in the bucket"
                mono
              />
              <Field
                label="Days from upload to hide"
                placeholder="60"
                value={form.daysToHide}
                onChange={(v) => setForm({ ...form, daysToHide: v })}
                help="Blank = never auto-hide"
              />
              <Field
                label="Days from hide to delete"
                placeholder="30"
                value={form.daysToDelete}
                onChange={(v) => setForm({ ...form, daysToDelete: v })}
                help="Blank = keep hidden forever"
              />
              <p className="sm:col-span-3 text-[11px] text-ink-400">
                B2 lifecycle rules <strong>only hide and delete</strong> files. There is no transition to a colder tier.
              </p>
            </div>
          )}

          {error && <ErrorBanner message={error} />}

          <ModalFooter>
            <button type="button" onClick={onClose} className="rounded-md border border-ink-700 bg-ink-850 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100">Cancel</button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create bucket'}
            </button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

// =============================================================================
// Shared form primitives
// =============================================================================
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
        className={"w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40 " + (mono ? "font-mono" : "")}
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
    <div className="rounded-md border border-bb-red/30 bg-bb-red/5 px-3 py-2 text-xs text-bb-red">
      {message}
    </div>
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
