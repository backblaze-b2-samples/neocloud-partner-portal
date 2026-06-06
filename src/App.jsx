import React, { useState, useEffect, Suspense, lazy, useCallback, useMemo } from 'react';
import { Eye, X } from 'lucide-react';
import { Sidebar, TopBar, CustomerSidebar, CustomerTopBar } from './components/Layout.jsx';
import { CommandPalette } from './components/CommandPalette.jsx';
import { LoadingState } from './components/ui.jsx';
import { AppProvider, useApp } from './lib/AppContext.jsx';
import { NavContext } from './lib/nav.js';
import { configureAdapter } from './api/b2Adapter.js';
import { configurePartner } from './api/partnerApi.js';
import { CUSTOMERS } from './data/customers.js';

// Re-export for backward compat — older views may still import useNav from here.
export { useNav } from './lib/nav.js';

const Overview = lazy(() => import('./views/ExecutiveOverview.jsx'));
const Cockpit = lazy(() => import('./views/CockpitView.jsx'));
const Groups = lazy(() => import('./views/GroupsView.jsx'));
const Partner = lazy(() => import('./views/PartnerView.jsx'));
const CustomerDetail = lazy(() => import('./views/CustomerDetailView.jsx'));
const Storage = lazy(() => import('./views/StorageView.jsx'));
const BucketDetail = lazy(() => import('./views/BucketDetailView.jsx'));
const Regions = lazy(() => import('./views/RegionView.jsx'));
const Usage = lazy(() => import('./views/UsageBillingView.jsx'));
const Keys = lazy(() => import('./views/ApplicationKeysView.jsx'));
const KeyDetail = lazy(() => import('./views/KeyDetailView.jsx'));
const Console = lazy(() => import('./views/ApiConsoleView.jsx'));
const Mcp = lazy(() => import('./views/McpConsoleView.jsx'));
const Settings = lazy(() => import('./views/SettingsView.jsx'));
const ResellerPlans = lazy(() => import('./views/ResellerPlansView.jsx'));
const Login = lazy(() => import('./views/LoginView.jsx'));
const Support = lazy(() => import('./views/SupportView.jsx'));
const Account = lazy(() => import('./views/AccountView.jsx'));
const UserManagement = lazy(() => import('./views/UserManagementView.jsx'));
const UserDetail = lazy(() => import('./views/UserDetailView.jsx'));
const AuditLog = lazy(() => import('./views/AuditLogView.jsx'));
const CustomerUsers = lazy(() => import('./views/CustomerUsersView.jsx'));
const Immutability = lazy(() => import('./views/ImmutabilityView.jsx'));
const TrustCenter = lazy(() => import('./views/TrustCenterView.jsx'));
const Residency = lazy(() => import('./views/ResidencyView.jsx'));

const VIEWS = {
  overview: Overview,
  cockpit: Cockpit,
  groups: Groups,
  partner: Partner,
  'customer-detail': CustomerDetail,
  storage: Storage,
  'bucket-detail': BucketDetail,
  regions: Regions,
  usage: Usage,
  keys: Keys,
  'key-detail': KeyDetail,
  console: Console,
  mcp: Mcp,
  settings: Settings,
  plans: ResellerPlans,
  account: Account,
  users: UserManagement,
  'user-detail': UserDetail,
  audit: AuditLog,
  'customer-users': CustomerUsers,
  support: Support,
  immutability: Immutability,
  trust: TrustCenter,
  residency: Residency,
};

// Routes only an admin may navigate to.
const ADMIN_ONLY = new Set(['users', 'user-detail', 'audit']);
// Routes restricted to admin + support staff.
const SUPPORT_TOOLS = new Set(['support']);

function ImpersonationBanner() {
  const { impersonator, user, stopImpersonation } = useApp();
  if (!impersonator) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-accent-amber/40 bg-accent-amber/15 px-6 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-accent-amber">
        <Eye size={14} className="shrink-0" />
        <span className="truncate">
          <span className="font-semibold">Read-only impersonation</span>
          <span className="mx-1.5 text-accent-amber/70">·</span>
          viewing as <span className="font-mono">{user?.email}</span>
          <span className="mx-1.5 text-accent-amber/70">·</span>
          signed in as <span className="font-mono">{impersonator.email}</span>
        </span>
      </div>
      <button
        onClick={stopImpersonation}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-accent-amber/40 bg-ink-900/40 px-2.5 text-[11px] font-medium text-accent-amber hover:bg-ink-900/70"
      >
        <X size={11} /> Exit impersonation
      </button>
    </div>
  );
}

function CustomerShell() {
  const { config, user, isCustomerAdmin, customerAccountId, authReady, isAuthenticated } = useApp();

  // Resolve the customerId used by views and the partner API.
  // In demo mode that's the hardcoded numeric id from src/data/customers.js;
  // in live mode the accountId itself doubles as the customer id
  // (see partnerApi.getCustomer — "In live mode, id IS the accountId").
  const customerId = useMemo(() => {
    if (!customerAccountId) return null;
    if (config.mode === 'live') return customerAccountId;
    return CUSTOMERS.find((c) => c.accountId === customerAccountId)?.id || null;
  }, [customerAccountId, config.mode]);

  const [active, setActive] = useState('my-overview');
  const [params, setParams] = useState({});
  const [navOpen, setNavOpen] = useState(false);

  configureAdapter({
    mode: config.mode,
    masterKeyId: config.masterKeyId,
    masterApplicationKey: config.masterApplicationKey,
    proxyUrl: config.proxyUrl,
    reportsBucketName: config.reportsBucketName || '',
  });
  configurePartner({
    mode: config.mode,
    proxyUrl: config.proxyUrl,
  });

  const navigate = useCallback((view, p = {}) => {
    setActive(view);
    setParams(p);
    setNavOpen(false);
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const mustChangePassword = !!user?.mustChangePassword;
  useEffect(() => {
    if (mustChangePassword && active !== 'account') setActive('account');
  }, [mustChangePassword, active]);

  // Build view-specific locked params
  const viewParams = useMemo(() => {
    if (active === 'my-overview') return { ...params, customerId };
    if (active === 'storage') return { ...params, lockedAccountId: customerAccountId };
    if (active === 'keys') return { ...params, lockedCustomerId: customerId, lockedAccountId: customerAccountId };
    return params;
  }, [active, params, customerId, customerAccountId]);

  const CUSTOMER_VIEWS = {
    'my-overview': CustomerDetail,
    storage: Storage,
    usage: Usage,
    keys: Keys,
    'customer-users': CustomerUsers,
    mcp: Mcp,
    account: Account,
  };

  const View = CUSTOMER_VIEWS[active] || CustomerDetail;

  return (
    <NavContext.Provider value={{ active, params: viewParams, navigate }}>
      <div className="flex h-full flex-col">
        <ImpersonationBanner />
        <div className="flex min-h-0 flex-1">
          <CustomerSidebar active={active} onSelect={(id) => navigate(id)} isCustomerAdmin={isCustomerAdmin} mobileOpen={navOpen} onMobileClose={() => setNavOpen(false)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <CustomerTopBar active={active} onMenu={() => setNavOpen(true)} />
            <main className="flex-1 overflow-y-auto px-4 py-6 pb-safe-b sm:px-6 lg:px-10 lg:py-8">
              <Suspense fallback={<LoadingState label="Loading view" />}>
                <View key={`${active}-${config.mode}`} {...viewParams} />
              </Suspense>
            </main>
          </div>
        </div>
      </div>
    </NavContext.Provider>
  );
}

function Shell() {
  const { config, isAuthenticated, authReady, isAdmin, isSupport, isCustomer, user } = useApp();
  const [active, setActive] = useState('overview');
  const [params, setParams] = useState({});
  const [navOpen, setNavOpen] = useState(false);

  // Configure adapters synchronously during render — NOT in a useEffect.
  // If this were a useEffect, child effects (view data fetches) would fire
  // before the adapter is updated to the new mode, causing stale data on
  // demo↔live switches.
  configureAdapter({
    mode: config.mode,
    masterKeyId: config.masterKeyId,
    masterApplicationKey: config.masterApplicationKey,
    proxyUrl: config.proxyUrl,
    reportsBucketName: config.reportsBucketName || '',
  });
  configurePartner({
    mode: config.mode,
    proxyUrl: config.proxyUrl,
  });

  const navigate = useCallback((view, p = {}) => {
    setActive(view);
    setParams(p);
    setNavOpen(false);
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Redirect away from admin-only views if the user loses admin access.
  useEffect(() => {
    if (ADMIN_ONLY.has(active) && !isAdmin) setActive('overview');
    if (SUPPORT_TOOLS.has(active) && !isAdmin && !isSupport) setActive('overview');
  }, [active, isAdmin, isSupport]);

  // Force the change-password screen if the server flagged the user.
  const mustChangePassword = !!user?.mustChangePassword;
  useEffect(() => {
    if (mustChangePassword && active !== 'account') setActive('account');
  }, [mustChangePassword, active]);

  if (!authReady) {
    return (
      <div className="grid h-full place-items-center bg-ink-950">
        <LoadingState label="Loading…" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Suspense fallback={<LoadingState label="Loading sign-in" />}>
        <Login />
      </Suspense>
    );
  }

  if (isCustomer) {
    return <CustomerShell />;
  }

  const View = VIEWS[active] || Overview;

  return (
    <NavContext.Provider value={{ active, params, navigate }}>
      <CommandPalette />
      <div className="flex h-full flex-col">
        <ImpersonationBanner />
        <div className="flex min-h-0 flex-1">
          <Sidebar active={active} onSelect={(id) => navigate(id)} mobileOpen={navOpen} onMobileClose={() => setNavOpen(false)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar active={active} onOpenSettings={() => navigate('settings')} onMenu={() => setNavOpen(true)} />
            <main className="flex-1 overflow-y-auto px-4 py-6 pb-safe-b sm:px-6 lg:px-10 lg:py-8">
              <Suspense fallback={<LoadingState label="Loading view" />}>
                {/* key includes mode so switching demo↔live fully remounts the
                    view and re-fires all useEffect data fetches. */}
                <View key={`${active}-${config.mode}`} {...params} />
              </Suspense>
            </main>
          </div>
        </div>
      </div>
    </NavContext.Provider>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
