import React, { useEffect, useState } from 'react';
import { Receipt, Info, Save, Loader2, CheckCircle2, AlertTriangle, Plus, Trash2, X } from 'lucide-react';
import {
  PageHeader, Card, CardHeader, SourceBadge,
  Table, THead, TBody, TR, TH, TD, LoadingState,
} from '../components/ui.jsx';
import { Modal, ModalFooter } from '../components/Modal.jsx';
import { B2_LIST_PRICE } from '../data/resellerPlans.js';
import { api, ApiError } from '../lib/apiClient.js';
import { useApp } from '../lib/AppContext.jsx';
import { currency, percent, cx } from '../lib/format.js';

// A brand-new tier starts at zero across the board rather than inheriting a
// sample tier's markup — an operator setting up their own pricing should type
// every number deliberately.
const BLANK_PLAN = {
  name: '', description: '',
  storagePerTb: 0, egressPerGb: 0,
  classAPer10k: 0, classBPer10k: 0, classCPer10k: 0, classDPer10k: 0,
};

export default function ResellerPlansView() {
  // Gate on the permission, not on role === 'admin'. plans:write is held by the
  // Commercial role too, so gating on admin hid every control from exactly the
  // people whose job this screen is — while the server happily accepted their
  // writes. Matches how RolesView / UserManagementView gate.
  const { can } = useApp();
  const mayWrite = can('plans:write');
  const [plans, setPlans]       = useState(null);
  const [error, setError]       = useState('');
  const [adding, setAdding]     = useState(false);
  const [deleting, setDeleting] = useState(null);   // the plan awaiting confirmation

  const reload = () => {
    setError('');
    api.get('/api/admin/reseller-plans')
      .then((d) => setPlans(d.plans))
      .catch((err) => setError(
        err instanceof ApiError && err.status === 401
          ? 'Sign in required to view plans.'
          : 'Could not load plans.'
      ));
  };
  useEffect(reload, []);

  if (plans === null) return <LoadingState label="Loading reseller plans" />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="System"
        title="Reseller plans"
        subtitle={mayWrite
          ? 'Set the markup over Backblaze list pricing for each tier. Changes apply to every customer assigned to that plan unless they have a per-customer override.'
          : 'Read-only view of plan tiers. Editing requires the plans:write permission.'}
        actions={
          <div className="flex items-center gap-2">
            {mayWrite && (
              <button
                onClick={() => { setError(''); setAdding(true); }}
                className="inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[11px] font-medium text-ink-100 hover:bg-ink-800"
              >
                <Plus size={12} /> Add plan
              </button>
            )}
            <SourceBadge source="api" />
          </div>
        }
      />

      <Card padding="p-4" className="bg-ink-900/60">
        <div className="flex items-start gap-2">
          <Info size={14} className="mt-0.5 text-ink-400 shrink-0" />
          <div className="text-[11.5px] text-ink-300 space-y-1">
            <p>
              <span className="font-semibold text-ink-100">B2 list pricing (your COGS):</span>{' '}
              Storage <span className="font-mono text-ink-100">{currency(B2_LIST_PRICE.storagePerTb)}/TB/mo</span> ·
              {' '}Egress <span className="font-mono text-ink-100">{currency(B2_LIST_PRICE.egressPerGb, { decimals: 3 })}/GB</span>
              {' '}(after 3× stored free) ·
              {' '}Class A/B/C <span className="font-mono text-ink-100">free</span> ·
              {' '}Class D <span className="font-mono text-ink-100">{currency(B2_LIST_PRICE.classDPer10k, { decimals: 4 })}/10k</span>
              {' '}(first {B2_LIST_PRICE.classDFreePerDay.toLocaleString()}/day free).
            </p>
            <p className="text-ink-400">
              Class A/B/C are free at B2 list — partners can still mark them up to customers per tier or per customer.
            </p>
          </div>
        </div>
      </Card>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{error}</span>
        </div>
      )}

      <Card padding="p-0">
        <CardHeader
          title="Plan tiers"
          subtitle="Used when a customer has no per-account override."
          icon={<Receipt size={16} />}
        />
        <Table>
          <THead>
            <TR hover={false}>
              <TH>Plan</TH>
              <TH className="text-right">Storage / TB</TH>
              <TH className="text-right">Egress / GB</TH>
              <TH className="text-right">Class A / 10k</TH>
              <TH className="text-right">Class B / 10k</TH>
              <TH className="text-right">Class C / 10k</TH>
              <TH className="text-right">Class D / 10k</TH>
              <TH className="text-right">Accounts</TH>
              <TH className="text-right">Margin vs list</TH>
              <TH className="text-right">{mayWrite && 'Actions'}</TH>
            </TR>
          </THead>
          <TBody>
            {adding && (
              <PlanRow
                plan={BLANK_PLAN}
                isNew
                mayWrite={mayWrite}
                onSaved={() => { setAdding(false); reload(); }}
                onCancel={() => setAdding(false)}
                onError={setError}
              />
            )}
            {plans.map((p) => (
              <PlanRow
                key={p.id}
                plan={p}
                mayWrite={mayWrite}
                onSaved={reload}
                onDelete={() => { setError(''); setDeleting(p); }}
                onError={setError}
              />
            ))}
            {plans.length === 0 && !adding && (
              <TR hover={false}>
                <TD colSpan={10} className="py-8 text-center text-[11.5px] text-ink-400">
                  No plan tiers defined. Every customer without a per-account pricing
                  override bills at Backblaze list price — zero margin — until you add one.
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </Card>

      <DeletePlanDialog
        plan={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => { setDeleting(null); reload(); }}
        onError={setError}
      />

      <div className="rounded-md border border-ink-700 bg-ink-900/40 p-4 text-[11px] text-ink-400">
        Plans set what you <span className="text-ink-200">charge</span>. What you <span className="text-ink-200">pay</span> Backblaze
        is negotiated per partner group — set it under <span className="text-ink-200">Groups → your cost for this group</span> — so
        the margin column here is measured against B2 list price, not against your actual cost.
        Per-customer pricing overrides (under <span className="text-ink-200">Edit customer → pricing</span>) take precedence
        over plan defaults. Class A/B/C/D values stored in the database; editing is admin-only.
      </div>
    </div>
  );
}

function PlanRow({ plan, mayWrite, isNew = false, onSaved, onCancel, onDelete, onError }) {
  const [editing, setEditing] = useState(isNew);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [form, setForm]       = useState(() => initForm(plan));

  // Sync form when underlying plan changes (e.g. reload after save).
  useEffect(() => { setForm(initForm(plan)); }, [plan]);

  // Margin against B2 LIST, not against actual cost — a plan can apply across
  // groups, and each group has its own negotiated rate (see Groups → your cost
  // for this group). Real per-account margin lives in Billing. A brand-new tier
  // starts at 0/TB, which would divide by zero, so hold it at 0 until a rate is
  // entered.
  const storageMargin = plan.storagePerTb > 0
    ? (plan.storagePerTb - B2_LIST_PRICE.storagePerTb) / plan.storagePerTb
    : 0;

  const assigned = plan.assignedCount || 0;
  // Deleting a plan something still depends on would drop those accounts to B2
  // list price silently, so the server refuses it. Say so before they click.
  const blockedReason = assigned > 0
    ? `${assigned} account${assigned === 1 ? '' : 's'} assigned — reassign them first`
    : plan.groupId
      ? `Pinned to group ${plan.groupId} — unpin it first`
      : null;

  const save = async () => {
    const name = form.name.trim();
    if (!name) { onError('Plan name is required.'); return; }

    setSaving(true);
    onError('');
    const payload = {
      name,
      description:  form.description.trim(),
      storagePerTb: parseFloat(form.storagePerTb) || 0,
      egressPerGb:  parseFloat(form.egressPerGb)  || 0,
      classAPer10k: parseFloat(form.classAPer10k) || 0,
      classBPer10k: parseFloat(form.classBPer10k) || 0,
      classCPer10k: parseFloat(form.classCPer10k) || 0,
      classDPer10k: parseFloat(form.classDPer10k) || 0,
    };
    try {
      if (isNew) await api.post('/api/admin/reseller-plans', payload);
      else       await api.put(`/api/admin/reseller-plans/${plan.id}`, payload);
      setSaved(true);
      setEditing(false);
      onSaved();
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      onError((e?.body?.error) || `Could not ${isNew ? 'create' : 'save'} plan.`);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    const fmtTxn = (v) => v > 0 ? currency(v, { decimals: 4 }) : <span className="text-ink-500">free</span>;
    return (
      <TR hover={false}>
        <TD>
          <div className="font-medium text-ink-100">{plan.name}</div>
          <div className="text-[10.5px] text-ink-400">{plan.description}</div>
        </TD>
        <TD className="text-right font-mono">{currency(plan.storagePerTb)}</TD>
        <TD className="text-right font-mono">{currency(plan.egressPerGb, { decimals: 3 })}</TD>
        <TD className="text-right font-mono">{fmtTxn(plan.classAPer10k)}</TD>
        <TD className="text-right font-mono">{fmtTxn(plan.classBPer10k)}</TD>
        <TD className="text-right font-mono">{fmtTxn(plan.classCPer10k)}</TD>
        <TD className="text-right font-mono">{currency(plan.classDPer10k, { decimals: 4 })}</TD>
        <TD className={cx('text-right font-mono', assigned > 0 ? 'text-ink-100' : 'text-ink-500')}>
          {assigned}
        </TD>
        <TD className="text-right font-mono text-accent-green">{percent(storageMargin, 0)}</TD>
        <TD className="text-right">
          {mayWrite && (
            <div className="inline-flex items-center gap-1.5">
              <button
                onClick={() => setEditing(true)}
                className="rounded border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800"
              >
                {saved ? <span className="inline-flex items-center gap-1 text-accent-green"><CheckCircle2 size={11} /> Saved</span> : 'Edit'}
              </button>
              <button
                onClick={onDelete}
                disabled={!!blockedReason}
                title={blockedReason || `Delete ${plan.name}`}
                aria-label={`Delete ${plan.name}`}
                className={cx(
                  'rounded border px-2 py-1 text-[11px]',
                  blockedReason
                    ? 'cursor-not-allowed border-ink-800 bg-ink-900 text-ink-600'
                    : 'border-bb-red/30 bg-bb-red/10 text-bb-red hover:bg-bb-red/20'
                )}
              >
                <Trash2 size={11} />
              </button>
            </div>
          )}
        </TD>
      </TR>
    );
  }

  // Edit mode
  const NumberField = ({ field, step = '0.0001' }) => (
    <input
      type="number"
      step={step}
      min="0"
      value={form[field]}
      onChange={(e) => setForm({ ...form, [field]: e.target.value })}
      className="h-7 w-20 rounded border border-ink-700 bg-ink-900 px-1.5 text-right font-mono text-xs text-ink-100"
    />
  );

  return (
    <TR hover={false} className="bg-ink-900/40">
      <TD>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Plan name"
          aria-label="Plan name"
          maxLength={80}
          autoFocus={isNew}
          className="mb-1 h-7 w-48 rounded border border-ink-700 bg-ink-900 px-1.5 text-xs font-medium text-ink-100"
        />
        <input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Description (optional)"
          aria-label="Plan description"
          maxLength={200}
          className="h-6 w-48 rounded border border-ink-700 bg-ink-900 px-1.5 text-[10.5px] text-ink-300"
        />
      </TD>
      <TD className="text-right"><NumberField field="storagePerTb" step="0.01" /></TD>
      <TD className="text-right"><NumberField field="egressPerGb"  step="0.001" /></TD>
      <TD className="text-right"><NumberField field="classAPer10k" /></TD>
      <TD className="text-right"><NumberField field="classBPer10k" /></TD>
      <TD className="text-right"><NumberField field="classCPer10k" /></TD>
      <TD className="text-right"><NumberField field="classDPer10k" /></TD>
      <TD className="text-right font-mono text-ink-500">{isNew ? '—' : assigned}</TD>
      <TD className="text-right text-ink-500 italic text-[10.5px]">recalcs after save</TD>
      <TD className="text-right">
        <div className="inline-flex items-center gap-1.5">
          <button
            onClick={() => {
              if (isNew) { onCancel?.(); return; }
              setEditing(false);
              setForm(initForm(plan));
            }}
            disabled={saving}
            className="rounded border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-300 hover:text-ink-100"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className={cx(
              'inline-flex items-center gap-1 rounded border border-bb-red/30 bg-bb-red px-2 py-1 text-[11px] font-medium text-white',
              saving ? 'opacity-70' : 'hover:bg-bb-redDim'
            )}
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
            {isNew ? 'Create' : 'Save'}
          </button>
        </div>
      </TD>
    </TR>
  );
}

// Deleting a rate card is not reversible from the UI, and the server refuses it
// while anything still depends on the plan — so this only ever confirms a
// delete that is already safe.
function DeletePlanDialog({ plan, onClose, onDeleted, onError }) {
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    try {
      await api.delete(`/api/admin/reseller-plans/${plan.id}`);
      onDeleted();
    } catch (e) {
      onError((e?.body?.error) || 'Could not delete plan.');
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open={!!plan}
      onClose={onClose}
      title={`Delete ${plan?.name || 'plan'}?`}
      subtitle="This removes the rate card. Customers are unaffected — the server refuses the delete while any are assigned."
      size="sm"
    >
      <p className="text-[11.5px] text-ink-300">
        <span className="font-mono text-ink-100">{plan?.name}</span> has no accounts
        assigned to it. Deleting it cannot be undone from here.
      </p>
      <ModalFooter>
        <button
          onClick={onClose}
          disabled={deleting}
          className="inline-flex items-center gap-1 rounded border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[11px] text-ink-300 hover:text-ink-100"
        >
          <X size={11} /> Cancel
        </button>
        <button
          onClick={confirm}
          disabled={deleting}
          className={cx(
            'inline-flex items-center gap-1 rounded border border-bb-red/30 bg-bb-red px-2.5 py-1.5 text-[11px] font-medium text-white',
            deleting ? 'opacity-70' : 'hover:bg-bb-redDim'
          )}
        >
          {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
          Delete plan
        </button>
      </ModalFooter>
    </Modal>
  );
}

function initForm(plan) {
  return {
    name:         plan.name ?? '',
    description:  plan.description ?? '',
    storagePerTb: String(plan.storagePerTb),
    egressPerGb:  String(plan.egressPerGb),
    classAPer10k: String(plan.classAPer10k),
    classBPer10k: String(plan.classBPer10k),
    classCPer10k: String(plan.classCPer10k),
    classDPer10k: String(plan.classDPer10k),
  };
}
