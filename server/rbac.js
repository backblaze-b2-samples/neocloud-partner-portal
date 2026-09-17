// =============================================================================
// rbac — the permission catalog.
// =============================================================================
// Authorization answers two independent questions:
//
//   "what may you do?"    -> permissions, resolved from the user's role
//   "whose data is it?"   -> account_id + canAccessAccount() (unchanged)
//
// Keep them separate. A customer_admin has customers:read, but canAccessAccount
// still pins them to their own account_id. Widening a permission must never
// widen tenancy.
//
// The first block of strings is copied verbatim from the older
// backblaze-b2-samples/b2-partner-portal (app/rbac.py). Keeping the exact
// spellings means a future import of that portal's roles/role_permissions is a
// copy rather than a lossy translation — do not "tidy" these names.
// =============================================================================

// --- ported 1:1 from the old portal -----------------------------------------
export const USERS_READ       = 'users:read';
export const USERS_WRITE      = 'users:write';
export const ROLES_READ       = 'roles:read';
export const ROLES_WRITE      = 'roles:write';
export const SETTINGS_READ    = 'settings:read';
export const SETTINGS_WRITE   = 'settings:write';
export const GROUPS_READ      = 'groups:read';
export const MEMBERS_READ     = 'members:read';
export const MEMBERS_WRITE    = 'members:write';
export const MEMBERS_EJECT    = 'members:eject';
export const REPORTS_READ     = 'reports:read';
export const CREDENTIALS_READ = 'credentials:read';
export const AUDIT_READ       = 'audit:read';

// --- new for NeoCloud surfaces the old portal never had ----------------------
export const CREDENTIALS_WRITE = 'credentials:write';
export const CUSTOMERS_READ    = 'customers:read';
export const CUSTOMERS_WRITE   = 'customers:write';
export const BUCKETS_READ      = 'buckets:read';
export const FILES_READ        = 'files:read';
export const BILLING_READ      = 'billing:read';
export const PLANS_WRITE       = 'plans:write';
export const MCP_USE           = 'mcp:use';
export const MCP_ADMIN         = 'mcp:admin';
export const IMPERSONATE_START = 'impersonate:start';

// Display order — drives the Roles admin checkbox grid.
export const PERMISSION_GROUPS = [
  { label: 'Portal users',  permissions: [USERS_READ, USERS_WRITE, ROLES_READ, ROLES_WRITE, AUDIT_READ] },
  { label: 'Customers',     permissions: [CUSTOMERS_READ, CUSTOMERS_WRITE, GROUPS_READ, MEMBERS_READ, MEMBERS_WRITE, MEMBERS_EJECT] },
  { label: 'Storage',       permissions: [BUCKETS_READ, FILES_READ, REPORTS_READ] },
  { label: 'Commercial',    permissions: [BILLING_READ, PLANS_WRITE] },
  { label: 'Configuration', permissions: [SETTINGS_READ, SETTINGS_WRITE, CREDENTIALS_READ, CREDENTIALS_WRITE] },
  { label: 'Tools',         permissions: [MCP_USE, MCP_ADMIN, IMPERSONATE_START] },
];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions);

const PERMISSION_SET = new Set(ALL_PERMISSIONS);
export function isValidPermission(p) {
  return typeof p === 'string' && PERMISSION_SET.has(p);
}

// Human-readable, shown in the Roles UI. Mirrors the old portal's
// "Permissions Reference" table where the permission was ported from it.
export const PERMISSION_LABELS = {
  [USERS_READ]:        'View portal users',
  [USERS_WRITE]:       'Create, update, and deactivate portal users',
  [ROLES_READ]:        'View roles and their permissions',
  [ROLES_WRITE]:       'Create, update, and delete roles',
  [AUDIT_READ]:        'View and export the audit log',
  [CUSTOMERS_READ]:    'View customer accounts and their metadata',
  [CUSTOMERS_WRITE]:   'Edit customer metadata, plans, and pricing overrides',
  [GROUPS_READ]:       'List and view partner groups',
  [MEMBERS_READ]:      'List group members',
  [MEMBERS_WRITE]:     'Provision new group members',
  [MEMBERS_EJECT]:     'Remove members from groups',
  [BUCKETS_READ]:      'Browse buckets and their configuration',
  [FILES_READ]:        'Browse the file index and object listings',
  [REPORTS_READ]:      'Fetch and view usage reports',
  [BILLING_READ]:      'View revenue, cost, and margin figures',
  [PLANS_WRITE]:       'Edit reseller plan tiers',
  [SETTINGS_READ]:     'View portal settings, SSO config, and MCP config',
  [SETTINGS_WRITE]:    'Update portal settings, SSO config, and MCP config',
  [CREDENTIALS_READ]:  'Retrieve stored sub-account credentials',
  [CREDENTIALS_WRITE]: 'Provision and rotate sub-account credentials',
  [MCP_USE]:           'Use the MCP console',
  [MCP_ADMIN]:         'Configure the MCP connection and per-customer tokens',
  [IMPERSONATE_START]: 'Start a read-only "view as customer" session',
};

// =============================================================================
// Built-in roles.
// =============================================================================
// These permission sets are chosen to reproduce the pre-RBAC behavior EXACTLY,
// so introducing the permission layer is a refactor with no visible change:
//
//   admin              -> every requireRole('admin') gate, plus everything else
//   manager / user     -> canSeeRevenue included them, hence billing:read
//   support            -> impersonation + read; explicitly NOT users/settings
//                         (Layout.jsx filtered those two out for support)
//   customer_*         -> scoped to their own account by canAccessAccount
//
// built_in roles are editable (an operator may trim them) but not deletable.
// =============================================================================

// customers:read / customers:write gate the partner-wide customer-metadata
// surface (/api/admin/metadata — every tenant at once), which was admin-only
// before the permission layer. They stay admin-only here so upgrading does not
// silently widen who can read other tenants' plans and pricing overrides.
const PARTNER_READ_BASE = [
  GROUPS_READ, MEMBERS_READ, BUCKETS_READ, FILES_READ, REPORTS_READ, MCP_USE,
];

export const BUILT_IN_ROLES = [
  {
    id: 'admin', name: 'Administrator', scope: 'partner',
    description: 'Full access to every portal function.',
    permissions: ALL_PERMISSIONS,
  },
  // manager and user are deliberately identical: before the permission layer,
  // nothing in the codebase distinguished them (both were non-admin, and
  // canSeeRevenue covered admin/manager/user alike). Granting manager anything
  // extra here would be a silent privilege escalation on upgrade. Operators can
  // now differentiate the two by editing them.
  {
    id: 'manager', name: 'Manager', scope: 'partner',
    description: 'Partner staff with access to revenue figures.',
    permissions: [...PARTNER_READ_BASE, BILLING_READ],
  },
  {
    id: 'user', name: 'User', scope: 'partner',
    description: 'Standard partner staff access.',
    permissions: [...PARTNER_READ_BASE, BILLING_READ],
  },
  {
    id: 'support', name: 'Support', scope: 'partner',
    description: 'Read-only troubleshooting, plus "view as customer".',
    permissions: [...PARTNER_READ_BASE, IMPERSONATE_START],
  },
  {
    id: 'customer_admin', name: 'Customer administrator', scope: 'customer',
    description: 'Manages their own organisation’s users and storage.',
    // users:read/users:write here are for their OWN team via /api/customer-admin.
    // requirePartnerScope is what stops them reaching /api/admin/users.
    permissions: [BUCKETS_READ, FILES_READ, REPORTS_READ, BILLING_READ, MCP_USE, USERS_READ, USERS_WRITE],
  },
  {
    id: 'customer_readonly', name: 'Customer read-only', scope: 'customer',
    description: 'Read-only view of their own organisation’s storage.',
    permissions: [BUCKETS_READ, FILES_READ, REPORTS_READ],
  },
];
