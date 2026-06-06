// useCustomers() — returns the customer list appropriate to the current mode.
//   demo: the hardcoded CUSTOMERS dataset (sync, no loading state).
//   live: the result of partner.getCustomers() (async, exposes loading).
//
// Every view that wants to look up a customer by accountId / id should go
// through this hook instead of importing CUSTOMERS directly. Importing the
// raw array silently breaks live mode because real accounts aren't in it.

import { useEffect, useState } from 'react';
import { useApp } from './AppContext.jsx';
import { getCustomers } from '../api/partnerApi.js';
import { CUSTOMERS } from '../data/customers.js';

export function useCustomers() {
  const { isLive } = useApp();
  const [data, setData] = useState(isLive ? null : CUSTOMERS);

  useEffect(() => {
    if (!isLive) { setData(CUSTOMERS); return; }
    let cancelled = false;
    setData(null);
    getCustomers()
      .then((d) => { if (!cancelled) setData(d.customers || []); })
      .catch(() => { if (!cancelled) setData([]); });
    return () => { cancelled = true; };
  }, [isLive]);

  return { customers: data || [], loading: isLive && data === null };
}
