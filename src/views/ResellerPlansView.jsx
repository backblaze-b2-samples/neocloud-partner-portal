import React, { useEffect, useState } from 'react';
import { Receipt, Info, Save, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import {
  PageHeader, Card, CardHeader, SourceBadge,
  Table, THead, TBody, TR, TH, TD, LoadingState,
} from '../components/ui.jsx';
import { B2_LIST_PRICE } from '../data/resellerPlans.js';
import { api, ApiError } from '../lib/apiClient.js';
import { useApp } from '../lib/AppContext.jsx';
import { currency, percent, cx } from '../lib/format.js';

export default function ResellerPlansView() {
  const { isAdmin } = useApp();
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState('');

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
        subtitle={isAdmin
          ? 'Set the markup over Backblaze list pricing for each tier. Changes apply to every customer assigned to that plan unless they have a per-customer override.'
          : 'Read-only view of plan tiers. An admin can edit pricing.'}
        actions={<SourceBadge source="api" />}
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
              <TH className="text-right">Storage margin</TH>
              <TH className="text-right">{isAdmin && 'Actions'}</TH>
            </TR>
          </THead>
          <TBody>
            {plans.map((p) => (
              <PlanRow key={p.id} plan={p} isAdmin={isAdmin} onSaved={reload} onError={setError} />
            ))}
          </TBody>
        </Table>
      </Card>

      <div className="rounded-md border border-ink-700 bg-ink-900/40 p-4 text-[11px] text-ink-400">
        Per-customer pricing overrides (under <span className="text-ink-200">Edit customer → pricing</span>) take precedence
        over plan defaults. Class A/B/C/D values stored in the database; editing is admin-only.
      </div>
    </div>
  );
}

function PlanRow({ plan, isAdmin, onSaved, onError }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [form, setForm]       = useState(() => initForm(plan));

  // Sync form when underlying plan changes (e.g. reload after save).
  useEffect(() => { setForm(initForm(plan)); }, [plan]);

  const storageMargin = (plan.storagePerTb - B2_LIST_PRICE.storagePerTb) / plan.storagePerTb;

  const save = async () => {
    setSaving(true);
    onError('');
    try {
      await api.put(`/api/admin/reseller-plans/${plan.id}`, {
        storagePerTb: parseFloat(form.storagePerTb),
        egressPerGb:  parseFloat(form.egressPerGb),
        classAPer10k: parseFloat(form.classAPer10k),
        classBPer10k: parseFloat(form.classBPer10k),
        classCPer10k: parseFloat(form.classCPer10k),
        classDPer10k: parseFloat(form.classDPer10k),
      });
      setSaved(true);
      setEditing(false);
      onSaved();
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      onError((e?.body?.error) || 'Could not save plan.');
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
        <TD className="text-right font-mono text-accent-green">{percent(storageMargin, 0)}</TD>
        <TD className="text-right">
          {isAdmin && (
            <button
              onClick={() => setEditing(true)}
              className="rounded border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800"
            >
              {saved ? <span className="inline-flex items-center gap-1 text-accent-green"><CheckCircle2 size={11} /> Saved</span> : 'Edit'}
            </button>
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
        <div className="font-medium text-ink-100">{plan.name}</div>
        <div className="text-[10.5px] text-ink-400">{plan.description}</div>
      </TD>
      <TD className="text-right"><NumberField field="storagePerTb" step="0.01" /></TD>
      <TD className="text-right"><NumberField field="egressPerGb"  step="0.001" /></TD>
      <TD className="text-right"><NumberField field="classAPer10k" /></TD>
      <TD className="text-right"><NumberField field="classBPer10k" /></TD>
      <TD className="text-right"><NumberField field="classCPer10k" /></TD>
      <TD className="text-right"><NumberField field="classDPer10k" /></TD>
      <TD className="text-right text-ink-500 italic text-[10.5px]">recalcs after save</TD>
      <TD className="text-right">
        <div className="inline-flex items-center gap-1.5">
          <button
            onClick={() => { setEditing(false); setForm(initForm(plan)); }}
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
            Save
          </button>
        </div>
      </TD>
    </TR>
  );
}

function initForm(plan) {
  return {
    storagePerTb: String(plan.storagePerTb),
    egressPerGb:  String(plan.egressPerGb),
    classAPer10k: String(plan.classAPer10k),
    classBPer10k: String(plan.classBPer10k),
    classCPer10k: String(plan.classCPer10k),
    classDPer10k: String(plan.classDPer10k),
  };
}
