// Fetch the assignable role list once per page load.
//
// Roles are operator-definable now, so the set cannot be hardcoded in the
// bundle. Callers may hold users:write without roles:read, so a fetch failure
// falls back to the built-in ids rather than rendering an empty dropdown that
// would make user creation impossible.
import { useEffect, useState } from 'react';
import { api } from './apiClient.js';

const FALLBACK = [
  { id: 'admin',             name: 'Admin',              scope: 'partner'  },
  { id: 'manager',           name: 'Manager',            scope: 'partner'  },
  { id: 'user',              name: 'User',               scope: 'partner'  },
  { id: 'support',           name: 'Support',            scope: 'partner'  },
  { id: 'customer_admin',    name: 'Customer Admin',     scope: 'customer' },
  { id: 'customer_readonly', name: 'Customer Read-only', scope: 'customer' },
];

let cache = null;

export function useRoles() {
  const [roles, setRoles] = useState(cache);

  useEffect(() => {
    if (cache) return undefined;
    let cancelled = false;
    api.get('/api/admin/roles')
      .then((d) => {
        const list = Array.isArray(d.roles) && d.roles.length ? d.roles : FALLBACK;
        cache = list;
        if (!cancelled) setRoles(list);
      })
      .catch(() => { if (!cancelled) setRoles(FALLBACK); });
    return () => { cancelled = true; };
  }, []);

  return roles || FALLBACK;
}
