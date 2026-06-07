// Unit tests for the bucket/file/key payload builders — the audited "where a
// silent data-correctness or security regression would land" logic.
import { describe, it, expect } from 'vitest';
import {
  genRuleName, buildLifecycleRules, buildCorsRules, buildBucketInfo,
  buildBucketUpdate, fileProtectionPlan, performRotate, buildCreateKeyBody,
} from '../../src/lib/bucketPayloads.js';

describe('genRuleName', () => {
  it('is always 6–63 chars of [A-Za-z0-9-] (B2 rule-name constraint)', () => {
    for (let i = 0; i < 200; i++) {
      const n = genRuleName();
      expect(n.length).toBeGreaterThanOrEqual(6);
      expect(n.length).toBeLessThanOrEqual(63);
      expect(n).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });
  it('honors a custom prefix', () => expect(genRuleName('cors')).toMatch(/^cors-\d{6}$/));
});

describe('buildLifecycleRules', () => {
  it('maps blank day fields to null and numbers through', () => {
    expect(buildLifecycleRules([{ fileNamePrefix: 'a/', daysFromUploadingToHiding: '30', daysFromHidingToDeleting: '' }]))
      .toEqual([{ fileNamePrefix: 'a/', daysFromUploadingToHiding: 30, daysFromHidingToDeleting: null }]);
  });
  it('throws when a rule has neither hide nor delete days', () => {
    expect(() => buildLifecycleRules([{ fileNamePrefix: '', daysFromUploadingToHiding: '', daysFromHidingToDeleting: '' }]))
      .toThrow(/hide and\/or delete/);
  });
});

describe('buildCorsRules', () => {
  const ok = { corsRuleName: '', allowedOrigins: 'https://a.com, https://b.com', allowedOperations: new Set(['s3_get', 's3_head']), maxAgeSeconds: '3600' };
  it('builds the API shape, Set→array, origins split, allowedHeaders [*]', () => {
    const [r] = buildCorsRules([ok]);
    expect(r.allowedOrigins).toEqual(['https://a.com', 'https://b.com']);
    expect(r.allowedOperations).toEqual(['s3_get', 's3_head']);
    expect(r.allowedHeaders).toEqual(['*']);
    expect(r.maxAgeSeconds).toBe(3600);
    expect(r.corsRuleName).toMatch(/^[A-Za-z0-9-]{6,63}$/); // auto-name valid length
  });
  it('keeps a valid user-supplied name', () => {
    expect(buildCorsRules([{ ...ok, corsRuleName: 'web-app' }])[0].corsRuleName).toBe('web-app');
  });
  it('throws on no origins, no operations, or a too-short/invalid name', () => {
    expect(() => buildCorsRules([{ ...ok, allowedOrigins: '' }])).toThrow(/origin/);
    expect(() => buildCorsRules([{ ...ok, allowedOperations: new Set() }])).toThrow(/operation/);
    expect(() => buildCorsRules([{ ...ok, corsRuleName: 'short' }])).toThrow(/6–63/);
    expect(() => buildCorsRules([{ ...ok, corsRuleName: 'has space' }])).toThrow(/6–63/);
  });
});

describe('buildBucketInfo', () => {
  it('drops blank keys, keeps the rest', () => {
    expect(buildBucketInfo([{ k: 'team', v: 'ml' }, { k: '', v: 'x' }, { k: ' env ', v: 'prod' }]))
      .toEqual({ team: 'ml', env: 'prod' });
  });
});

describe('buildBucketUpdate', () => {
  const base = {
    accountId: 'a1', bucketId: 'b1', bucketType: 'allPrivate',
    rules: [], corsRules: [], info: [],
    initialEncryption: 'SSE-B2', lockEnabled: false,
    retMode: 'none', retDuration: '', retUnit: 'days', initialRet: { mode: 'none', duration: '', unit: 'days' },
  };
  it('omits encryption when unchanged', () => {
    expect('encryption' in buildBucketUpdate({ ...base, encryption: 'SSE-B2' })).toBe(false);
  });
  it('includes encryption only when changed', () => {
    expect(buildBucketUpdate({ ...base, encryption: 'none' }).encryption).toBe('none');
  });
  it('omits defaultRetention when lock is disabled', () => {
    expect('defaultRetention' in buildBucketUpdate({ ...base, encryption: 'SSE-B2', lockEnabled: false, retMode: 'governance', retDuration: '30' })).toBe(false);
  });
  it('clears retention with {mode:null} when changed to none', () => {
    const p = buildBucketUpdate({ ...base, encryption: 'SSE-B2', lockEnabled: true, retMode: 'none', initialRet: { mode: 'governance', duration: 30, unit: 'days' } });
    expect(p.defaultRetention).toEqual({ mode: null });
  });
  it('sets retention period when changed to a mode', () => {
    const p = buildBucketUpdate({ ...base, encryption: 'SSE-B2', lockEnabled: true, retMode: 'compliance', retDuration: '7', retUnit: 'years', initialRet: { mode: 'none', duration: '', unit: 'days' } });
    expect(p.defaultRetention).toEqual({ mode: 'compliance', period: { duration: 7, unit: 'years' } });
  });
  it('omits retention when unchanged', () => {
    const p = buildBucketUpdate({ ...base, encryption: 'SSE-B2', lockEnabled: true, retMode: 'governance', retDuration: '30', retUnit: 'days', initialRet: { mode: 'governance', duration: 30, unit: 'days' } });
    expect('defaultRetention' in p).toBe(false);
  });
  it('always carries bucketType, lifecycle, cors, bucketInfo', () => {
    const p = buildBucketUpdate({ ...base, encryption: 'SSE-B2' });
    expect(p).toMatchObject({ accountId: 'a1', bucketId: 'b1', bucketType: 'allPrivate', lifecycleRules: [], corsRules: [], bucketInfo: {} });
  });
});

describe('fileProtectionPlan', () => {
  const base = { legalHold: false, initialLegalHold: false, retMode: 'none', initialRetMode: 'none', retUntil: '', initialRetUntil: '', bypass: false };
  it('is empty when nothing changed', () => {
    expect(fileProtectionPlan(base)).toEqual({});
  });
  it('emits legalHold only when toggled', () => {
    expect(fileProtectionPlan({ ...base, legalHold: true }).legalHold).toBe('on');
    expect(fileProtectionPlan({ ...base, legalHold: false, initialLegalHold: true }).legalHold).toBe('off');
  });
  it('uses end-of-day UTC for retain-until', () => {
    const p = fileProtectionPlan({ ...base, retMode: 'governance', retUntil: '2026-06-10' });
    expect(p.retention.mode).toBe('governance');
    expect(p.retention.retainUntilTimestamp).toBe(Date.parse('2026-06-10T23:59:59Z'));
    expect(p.retention.bypassGovernance).toBe(false);
  });
  it('throws when a retention mode is set without a date', () => {
    expect(() => fileProtectionPlan({ ...base, retMode: 'compliance', retUntil: '' })).toThrow(/retain until/i);
  });
  it('clearing retention (mode none, changed) sends no timestamp', () => {
    const p = fileProtectionPlan({ ...base, retMode: 'none', initialRetMode: 'governance' });
    expect(p.retention).toEqual({ mode: 'none', bypassGovernance: false });
  });
  it('passes bypassGovernance through', () => {
    const p = fileProtectionPlan({ ...base, retMode: 'governance', retUntil: '2026-06-10', bypass: true });
    expect(p.retention.bypassGovernance).toBe(true);
  });
});

describe('performRotate', () => {
  const apiKey = { applicationKeyId: 'K-old', keyName: 'writer', capabilities: ['writeFiles'], bucketIds: ['bkt-1', 'bkt-2'], namePrefix: 'p/' };

  it('creates the replacement with the SAME scope (bucketIds array) + caps, then revokes the old key', async () => {
    let createArgs, deleteArgs;
    const createKey = async (a) => { createArgs = a; return { applicationKeyId: 'K-new', applicationKey: 'secret-xyz' }; };
    const deleteKey = async (a) => { deleteArgs = a; return { ok: true }; };
    const { replacement, revokeWarning } = await performRotate({ createKey, deleteKey, apiKey, validDurationInSeconds: 604800 });
    expect(createArgs.bucketIds).toEqual(['bkt-1', 'bkt-2']);
    expect(createArgs.capabilities).toEqual(['writeFiles']);
    expect(createArgs.validDurationInSeconds).toBe(604800);
    expect(deleteArgs).toEqual({ applicationKeyId: 'K-old' });
    expect(replacement.applicationKey).toBe('secret-xyz');
    expect(revokeWarning).toBeNull();
  });

  it('still returns the new secret + a warning if the revoke fails (never loses the secret, never silently leaves two live keys)', async () => {
    const createKey = async () => ({ applicationKeyId: 'K-new', applicationKey: 'secret-xyz' });
    const deleteKey = async () => { throw new Error('network down'); };
    const { replacement, revokeWarning } = await performRotate({ createKey, deleteKey, apiKey });
    expect(replacement.applicationKey).toBe('secret-xyz');
    expect(revokeWarning).toMatch(/K-old/);
    expect(revokeWarning).toMatch(/could NOT be revoked/);
    expect(revokeWarning).toMatch(/network down/);
  });

  it('propagates a create failure (so the old key is never touched)', async () => {
    let deleteCalled = false;
    const createKey = async () => { throw new Error('cap not allowed'); };
    const deleteKey = async () => { deleteCalled = true; };
    await expect(performRotate({ createKey, deleteKey, apiKey })).rejects.toThrow(/cap not allowed/);
    expect(deleteCalled).toBe(false);
  });
});

describe('buildCreateKeyBody (v4 bucketIds array)', () => {
  it('sends bucketIds as an array, never a singular bucketId', () => {
    const body = buildCreateKeyBody({ keyName: 'k', capabilities: ['readFiles'], bucketIds: ['b1', 'b2'], namePrefix: 'x/', validDurationInSeconds: 3600 });
    expect(body.bucketIds).toEqual(['b1', 'b2']);
    expect('bucketId' in body).toBe(false);
    expect(body).toMatchObject({ keyName: 'k', capabilities: ['readFiles'], namePrefix: 'x/', validDurationInSeconds: 3600 });
  });
  it('omits bucketIds for an account-wide key (empty array)', () => {
    const body = buildCreateKeyBody({ keyName: 'k', capabilities: ['readFiles'], bucketIds: [] });
    expect('bucketIds' in body).toBe(false);
  });
  it('omits optional fields when absent', () => {
    expect(buildCreateKeyBody({ keyName: 'k', capabilities: ['listBuckets'] }))
      .toEqual({ keyName: 'k', capabilities: ['listBuckets'] });
  });
});
