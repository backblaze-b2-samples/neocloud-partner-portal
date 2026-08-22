import React, { useEffect, useState, useCallback } from 'react';
import {
  KeySquare, Plus, Trash2, Save, AlertTriangle, Loader2, Lock, Users as UsersIcon,
} from 'lucide-react';
import { Card, CardHeader, LoadingState, PageHeader, Tag } from '../components/ui.jsx';
import { useApp } from '../lib/AppContext.jsx';
import { api, ApiError } from '../lib/apiClient.js';
import { cx } from '../lib/format.js';

// Which permissions a customer-scope role is allowed to hold. Mirrors
// CUSTOMER_ALLOWED in server/roles.js — the server sanitises regardless, this
// just avoids offering checkboxes that would be silently dropped.
const CUSTOMER_ALLOWED = new Set([
  'buckets:read', 'files:read', 'reports:read', 'billing:read',
  'mcp:use', 'users:read', 'users:write',
]);

const BLANK = { id: '', name: '', description: '', scope: 'partner', permissions: [] };

export default function RolesView() {
  const { can } = useApp();
  const [roles, setRoles] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState(null);   // role id, or '__new__'
  const [draft, setDraft] = useState(BLANK);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const mayWrite = can('roles:write');

  const reload = useCallback(async () => {
    setError('');
    try {
      const [r, c] = await Promise.all([
        api.get('/api/admin/roles'),
        api.get('/api/admin/roles/permissions'),
      ]);
      setRoles(r.roles);
      setCatalog(c);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view roles.'
        : 'Could not load roles.');
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const openRole = (role) => {
    setNotice(''); setError('');
    setSelected(role.id);
    setDraft({
      id: role.id, name: role.name, description: role.description,
      scope: role.scope, permissions: [...role.permissions],
    });
  };

  const openNew = () => {
    setNotice(''); setError('');
    setSelected('__new__');
    setDraft({ ...BLANK });
  };

  const togglePermission = (p) => {
    setDraft((d) => ({
      ...d,
      permissions: d.permissions.includes(p)
        ? d.permissions.filter((x) => x !== p)
        : [...d.permissions, p],
    }));
  };

  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const isNew = selected === '__new__';
      const res = isNew
        ? await api.post('/api/admin/roles', draft)
        : await api.put(`/api/admin/roles/${draft.id}`, {
            name: draft.name, description: draft.description, permissions: draft.permissions,
          });
      // The server drops permissions a role may not hold; say so rather than
      // letting the checkbox state imply they were saved.
      if (res.rejected?.length) {
        setNotice(`Saved. ${res.rejected.length} permission(s) were not applicable to this role and were dropped.`);
      } else {
        setNotice('Saved.');
      }
      await reload();
      if (isNew) setSelected(res.role.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the role.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (role) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api.delete(`/api/admin/roles/${role.id}`);
      setSelected(null);
      await reload();
      setNotice(`Deleted “${role.name}”.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the role.');
    } finally {
      setBusy(false);
    }
  };

  if (error && !roles) {
    return (
      <div className="mx-auto max-w-xl">
        <Card>
          <div className="flex items-start gap-2 text-sm text-ink-200">
            <AlertTriangle size={16} className="mt-0.5 text-bb-red" />
            <div>
              <div className="font-medium">Forbidden</div>
              <p className="mt-1 text-xs text-ink-400">{error}</p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!roles || !catalog) return <LoadingState label="Loading roles" />;

  const current = roles.find((r) => r.id === selected);
  const editing = selected === '__new__' || !!current;
  const allowed = (p) => draft.scope !== 'customer' || CUSTOMER_ALLOWED.has(p);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Administration"
        title="Roles & permissions"
        subtitle="Roles are sets of permissions. Assign them to users, or map them from your identity provider."
        actions={mayWrite && (
          <button
            onClick={openNew}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-bb-red px-3 text-sm font-medium text-white hover:bg-bb-red/90"
          >
            <Plus size={14} /> New role
          </button>
        )}
      />

      {notice && (
        <div className="rounded-md border border-accent-green/30 bg-accent-green/10 px-3 py-2 text-xs text-accent-green">{notice}</div>
      )}
      {error && roles && (
        <div role="alert" className="rounded-md border border-bb-red/30 bg-bb-red/10 px-3 py-2 text-xs text-bb-red">{error}</div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Card padding="p-0">
          <CardHeader title="Roles" subtitle={`${roles.length} defined`} icon={<KeySquare size={16} />} className="p-5 pb-3" />
          <ul className="divide-y divide-ink-700/60">
            {roles.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => openRole(r)}
                  className={cx(
                    'flex w-full items-center justify-between gap-2 px-5 py-3 text-left transition hover:bg-ink-800/60',
                    selected === r.id && 'bg-ink-800'
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink-100">{r.name}</span>
                      {r.builtIn && <Tag variant="default">built-in</Tag>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-400">
                      <span className="font-mono">{r.id}</span>
                      <span>·</span>
                      <span>{r.scope}</span>
                      <span>·</span>
                      <span>{r.permissions.length} permissions</span>
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-400">
                    <UsersIcon size={12} />{r.userCount}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          {!editing ? (
            <div className="grid min-h-[240px] place-items-center text-center">
              <div>
                <KeySquare size={20} className="mx-auto text-ink-500" />
                <p className="mt-2 text-sm text-ink-300">Select a role to view its permissions.</p>
              </div>
            </div>
          ) : (
            <>
              <CardHeader
                title={selected === '__new__' ? 'New role' : draft.name}
                subtitle={selected === '__new__' ? 'Define a role and the permissions it grants.' : `Role id: ${draft.id}`}
                icon={<KeySquare size={16} />}
              />

              {current?.builtIn && (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-ink-700 bg-ink-900/60 px-3 py-2 text-[11px] text-ink-300">
                  <Lock size={13} className="mt-0.5 shrink-0 text-ink-400" />
                  <span>
                    This is a built-in role. You can change its permissions, but it cannot be deleted.
                    Changes apply to everyone holding it the next time they make a request.
                  </span>
                </div>
              )}

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {selected === '__new__' && (
                  <label className="block">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-ink-400">Role id</span>
                    <input
                      value={draft.id}
                      onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                      placeholder="auditor"
                      className="mt-1 h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 font-mono text-sm text-ink-100 focus:border-bb-red/50 focus:outline-none"
                    />
                    <span className="mt-1 block text-[10px] text-ink-500">Lowercase letters, digits, underscores. Cannot be changed later.</span>
                  </label>
                )}
                <label className="block">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-ink-400">Name</span>
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    disabled={!mayWrite}
                    className="mt-1 h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 focus:border-bb-red/50 focus:outline-none disabled:opacity-60"
                  />
                </label>
                {selected === '__new__' && (
                  <label className="block">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-ink-400">Scope</span>
                    <select
                      value={draft.scope}
                      onChange={(e) => setDraft({ ...draft, scope: e.target.value, permissions: [] })}
                      className="mt-1 h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 focus:border-bb-red/50 focus:outline-none"
                    >
                      <option value="partner">Partner staff</option>
                      <option value="customer">Customer user</option>
                    </select>
                    <span className="mt-1 block text-[10px] text-ink-500">
                      Customer roles are limited to their own account and cannot hold partner-wide permissions.
                    </span>
                  </label>
                )}
                <label className="block sm:col-span-2">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-ink-400">Description</span>
                  <input
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    disabled={!mayWrite}
                    className="mt-1 h-9 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-100 focus:border-bb-red/50 focus:outline-none disabled:opacity-60"
                  />
                </label>
              </div>

              <div className="mt-5 space-y-4">
                {catalog.groups.map((g) => {
                  const visible = g.permissions.filter(allowed);
                  if (visible.length === 0) return null;
                  return (
                    <div key={g.label}>
                      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">{g.label}</div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {visible.map((p) => (
                          <label
                            key={p}
                            className={cx(
                              'flex cursor-pointer items-start gap-2 rounded-md border border-ink-700 bg-ink-900/50 px-3 py-2',
                              !mayWrite && 'cursor-default opacity-70'
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={draft.permissions.includes(p)}
                              onChange={() => togglePermission(p)}
                              disabled={!mayWrite}
                              className="mt-0.5 h-3.5 w-3.5 accent-bb-red"
                            />
                            <span className="min-w-0">
                              <span className="block font-mono text-[11px] text-ink-200">{p}</span>
                              <span className="block text-[11px] text-ink-400">{catalog.labels[p]}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {mayWrite && (
                <div className="mt-5 flex items-center gap-2 border-t border-ink-700 pt-4">
                  <button
                    onClick={save}
                    disabled={busy}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-bb-red px-3 text-sm font-medium text-white hover:bg-bb-red/90 disabled:opacity-60"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    {selected === '__new__' ? 'Create role' : 'Save changes'}
                  </button>
                  {current && !current.builtIn && (
                    <button
                      onClick={() => remove(current)}
                      disabled={busy || current.userCount > 0}
                      title={current.userCount > 0 ? 'Reassign the users holding this role first' : undefined}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-ink-700 px-3 text-sm text-ink-200 hover:border-bb-red/50 hover:text-bb-red disabled:opacity-40"
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
