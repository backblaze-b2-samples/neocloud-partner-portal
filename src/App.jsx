import React, { useState, useEffect, Suspense, lazy, useCallback, useMemo } from 'react';
import { Sidebar, TopBar, CustomerSidebar, CustomerTopBar } from './components/Layout.jsx';
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
const Settings = lazy(() => import('./views/SettingsView.jsx'));
const ResellerPlans = lazy(() => import('./views/ResellerPlansView.jsx'));
const Login = lazy(() => import('./views/LoginView.jsx'));
const Account = lazy(() => import('./views/AccountView.jsx'));
const UserManagement = lazy(() => import('./views/UserManagementView.jsx'));
const UserDetail = lazy(() => import('./views/UserDetailView.jsx'));
const AuditLog = lazy(() => import('./views/AuditLogView.jsx'));
const CustomerUsers = lazy(() => import('./views/CustomerUsersView.jsx'));

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
  settings: Settings,
  plans: ResellerPlans,
  account: Account,
  users: UserManagement,
  'user-detail': UserDetail,
  audit: AuditLog,
  'customer-users': CustomerUsers,
};

// Routes only an admin may navigate to.
const ADMIN_ONLY = new Set(['users', 'user-detail', 'audit']);

function CustomerShell() {
  const { config, user, isCustomerAdmin, customerAccountId, authReady, isAuthenticated } = useApp();

  // Look up the demo customerId from accountId (demo mode only)
  const customerId = useMemo(() =>
    CUSTOMERS.find((c) => c.accountId === customerAccountId)?.id || null,
    [customerAccountId]
  );

  const [active, setActive] = useState('my-overview');
  const [params, setParams] = useState({});

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
    account: Account,
  };

  const View = CUSTOMER_VIEWS[active] || CustomerDetail;

  return (
    <NavContext.Provider value={{ active, params: viewParams, navigate }}>
      <div className="flex h-full">
        <CustomerSidebar active={active} onSelect={(id) => navigate(id)} isCustomerAdmin={isCustomerAdmin} />
        <div className="flex min-w-0 flex-1 flex-col">
          <CustomerTopBar active={active} />
          <main className="flex-1 overflow-y-auto px-6 py-6 lg:px-10 lg:py-8">
            <Suspense fallback={<LoadingState label="Loading view" />}>
              <View key={`${active}-${config.mode}`} {...viewParams} />
            </Suspense>
          </main>
        </div>
      </div>
    </NavContext.Provider>
  );
}

function Shell() {
  const { config, isAuthenticated, authReady, isAdmin, isCustomer, user } = useApp();
  const [active, setActive] = useState('overview');
  const [params, setParams] = useState({});

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
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Redirect away from admin-only views if the user loses admin access.
  useEffect(() => {
    if (ADMIN_ONLY.has(active) && !isAdmin) setActive('overview');
  }, [active, isAdmin]);

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
      <div className="flex h-full">
        <Sidebar active={active} onSelect={(id) => navigate(id)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar active={active} onOpenSettings={() => navigate('settings')} />
          <main className="flex-1 overflow-y-auto px-6 py-6 lg:px-10 lg:py-8">
            <Suspense fallback={<LoadingState label="Loading view" />}>
              {/* key includes mode so switching demo↔live fully remounts the
                  view and re-fires all useEffect data fetches. */}
              <View key={`${active}-${config.mode}`} {...params} />
            </Suspense>
          </main>
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
