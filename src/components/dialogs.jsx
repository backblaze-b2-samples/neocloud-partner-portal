// CreateCustomerDialog and CreateBucketDialog — wired through the same
// adapters so they work in both demo and live mode.

import React, { useState } from 'react';
import { Modal, ModalFooter } from './Modal.jsx';
import { Tag, SourceBadge } from './ui.jsx';
import { REGIONS } from '../data/regions.js';
import { GROUPS } from '../data/groups.js';
import * as partner from '../api/partnerApi.js';
import * as b2 from '../api/b2Adapter.js';
import { useApp } from '../lib/AppContext.jsx';
import { CheckCircle2 } from 'lucide-react';

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
            label="Group"
            value={form.groupId}
            onChange={(v) => setForm({ ...form, groupId: v })}
            options={GROUPS.map((g) => ({ value: g.groupId, label: g.groupName }))}
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
            options={['Reseller — Tier 1','Reseller — Tier 2','Reseller — Tier 3','Partner — Custom'].map((v) => ({ value: v, label: v }))}
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
// Create Bucket
// =============================================================================
export function CreateBucketDialog({ open, onClose, onCreated, customer }) {
  const { isLive } = useApp();
  const [form, setForm] = useState({
    bucketName: '',
    bucketType: 'allPrivate',
    encryption: 'SSE-B2',
    fileLock: 'none',
    versioning: 'enabled',
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
        customerId: customer?.id,
        region: customer?.region,
        encryption: form.encryption,
        fileLock: form.fileLock,
        versioning: form.versioning,
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
      bucketName: '', bucketType: 'allPrivate', encryption: 'SSE-B2', fileLock: 'none',
      versioning: 'enabled', addLifecycle: false, lifecyclePrefix: '', daysToHide: '', daysToDelete: '',
    });
    setCreated(null);
    setError(null);
  }

  return (
    <Modal
      open={open}
      onClose={() => { onClose(); setTimeout(reset, 200); }}
      title={customer ? `Create bucket for ${customer.name}` : 'Create bucket'}
      subtitle={isLive ? 'Live mode — calls b2_create_bucket on the customer\'s sub-account.' : 'Demo mode — creates a local-only bucket record.'}
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
              label="Encryption (default SSE)"
              value={form.encryption}
              onChange={(v) => setForm({ ...form, encryption: v })}
              options={[
                { value: 'SSE-B2', label: 'SSE-B2 (Backblaze-managed AES-256)' },
                { value: 'SSE-C', label: 'SSE-C (customer-managed keys)' },
                { value: 'none', label: 'None' },
              ]}
            />
            <Select
              label="Object Lock"
              value={form.fileLock}
              onChange={(v) => setForm({ ...form, fileLock: v })}
              options={[
                { value: 'none', label: 'Disabled' },
                { value: 'governance', label: 'Governance — overridable with bypassGovernance' },
                { value: 'compliance', label: 'Compliance — strict WORM' },
              ]}
            />
            <Select
              label="Versioning"
              value={form.versioning}
              onChange={(v) => setForm({ ...form, versioning: v })}
              options={[
                { value: 'enabled', label: 'enabled' },
                { value: 'disabled', label: 'disabled' },
              ]}
            />
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
