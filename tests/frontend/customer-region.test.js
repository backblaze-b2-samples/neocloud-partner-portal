// @vitest-environment jsdom
// Regression for a customer-reported bug: an account hosted on
// s3.eu-central-003 showed as us-west-002 in the portal. Live mode inferred
// region from the NeoCloud demo email convention and defaulted to us-west-002
// for anything else. The daily usage CSV's reporting_location is B2's own
// statement of where the account lives and must win.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const AYLO = '24a074628335';   // email has no -eu/-west suffix
const DEMO = 'demo0000west';   // email follows the demo convention

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function installFetch() {
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('b2_authorize_account')) {
      return jsonResponse({
        accountId: 'master000000', authorizationToken: 'tok',
        apiInfo: { storageApi: { apiUrl: 'https://api004.backblazeb2.com', downloadUrl: 'https://f004.backblazeb2.com', s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com' } },
      });
    }
    if (u.includes('/api/b2-partner/b2_list_groups')) {
      return jsonResponse({ groups: [{ groupId: 'g1', groupName: 'Aylo' }] });
    }
    if (u.includes('/api/b2-partner/b2_list_group_members')) {
      return jsonResponse({
        groupMembers: [
          { accountId: AYLO, email: 'infrabillingext+backblaze-effs@aylo.com', addedTimestamp: 1 },
          { accountId: DEMO, email: 'acme-west@neocloud.example', addedTimestamp: 1 },
        ],
        nextEmail: null,
      });
    }
    if (u.includes('/api/master-b2/reports-csv')) {
      return jsonResponse({
        bucketName: 'b2-reports-master000000',
        rows: [
          // reporting_location comes through the parser as `region`
          { date: '2026-09-16', accountId: AYLO, groupId: 'g1', bucketId: 'b1', bucketName: 'aylo-hot', region: 'eu-central-003', storageBytes: 2_880_000_000_000, egressBytes: 0 },
        ],
      });
    }
    if (u.includes('/api/admin/credentials')) return jsonResponse({ credentials: [] });
    if (u.includes('/api/admin/metadata'))    return jsonResponse({ metadata: [] });
    if (u.includes('/api/admin/reseller-plans')) return jsonResponse({ plans: [] });
    if (u.includes('/api/admin/group-costs'))    return jsonResponse({ costs: [] });
    if (u.includes('object-counts'))             return jsonResponse({ counts: [] });
    throw new Error(`unexpected fetch in test: ${u}`);
  });
}

describe('live-mode customer region', () => {
  let partnerApi;
  beforeEach(async () => {
    vi.resetModules();
    installFetch();
    document.cookie = 'csrf=x';
    const adapter = await import('../../src/api/b2Adapter.js');
    adapter.configureAdapter({ mode: 'live', masterKeyId: 'k', masterApplicationKey: 's', proxyUrl: 'http://proxy.test' });
    partnerApi = await import('../../src/api/partnerApi.js');
    partnerApi.configurePartner({ mode: 'live' });
  });

  it('takes the region from the usage CSV, not the email fallback', async () => {
    const { customers } = await partnerApi.getCustomers();
    const aylo = customers.find((c) => c.accountId === AYLO);
    expect(aylo).toBeTruthy();
    expect(aylo.region).toBe('eu-central-003');
  });

  it('still honours the demo email convention when the CSV has no rows for the account', async () => {
    const { customers } = await partnerApi.getCustomers();
    const demo = customers.find((c) => c.accountId === DEMO);
    expect(demo.region).toBe('us-west-002');
  });

  it('reports null rather than guessing when nothing knows the region', async () => {
    const fetchImpl = globalThis.fetch.getMockImplementation();
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (String(url).includes('/api/master-b2/reports-csv')) return jsonResponse({ bucketName: 'x', rows: [] });
      return fetchImpl(url, opts);
    });
    const { customers } = await partnerApi.getCustomers();
    const aylo = customers.find((c) => c.accountId === AYLO);
    expect(aylo.region).toBeNull();
  });
});
