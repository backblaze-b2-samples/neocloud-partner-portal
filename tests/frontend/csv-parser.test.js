// Tests for src/api/csvParser.js — both CSV formats with Class D, the
// builder/round-trip, the activity view, the rollup, and the cost model.
import { describe, it, expect } from 'vitest';
import {
  parseDailyUsageCsv,
  parseStandardUsageCsv,
  parseBackblazeGroupUsageCsv,
  rollupBy,
  activityFromCsv,
  buildUsageCsv,
  estimateCost,
  PRICING,
} from '../../src/api/csvParser.js';

// ---------- parseDailyUsageCsv (partner-style flat shape) ----------

describe('parseDailyUsageCsv', () => {
  it('parses headers + numeric columns including class_d_txn', () => {
    const csv = [
      'date,sub_account_id,bucket_id,storage_bytes_avg,upload_bytes,download_bytes,class_a_txn,class_b_txn,class_c_txn,class_d_txn',
      '2026-05-26,acct1,bk1,1000000,200,300,5,6,7,8',
    ].join('\n');
    const rows = parseDailyUsageCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].class_d_txn).toBe(8);
    expect(rows[0].storage_bytes_avg).toBe(1000000);
    expect(rows[0].sub_account_id).toBe('acct1');
  });

  it('treats absent class_d_txn column as null', () => {
    const csv = [
      'date,sub_account_id,class_a_txn',
      '2026-05-26,acct1,1',
    ].join('\n');
    const rows = parseDailyUsageCsv(csv);
    expect(rows[0].class_d_txn).toBeUndefined();
  });

  it('returns [] on empty / invalid input', () => {
    expect(parseDailyUsageCsv('')).toEqual([]);
    expect(parseDailyUsageCsv(null)).toEqual([]);
    expect(parseDailyUsageCsv('only-a-header')).toEqual([]);
  });
});

// ---------- parseStandardUsageCsv (account-level shape with classDTxn) ----------

describe('parseStandardUsageCsv', () => {
  it('maps class_d_txn → classDTxn', () => {
    const csv = [
      'date,account_id,bucket_id,storage_bytes_avg,download_bytes,upload_bytes,class_a_txn,class_b_txn,class_c_txn,class_d_txn',
      '2026-05-26,a1,b1,5e6,1000,200,10,20,30,40',
    ].join('\n');
    const rows = parseStandardUsageCsv(csv);
    expect(rows[0].classDTxn).toBe(40);
    expect(rows[0].storageBytes).toBe(5_000_000);
  });
});

// ---------- parseBackblazeGroupUsageCsv (partner-API shape with api_txn_class_d) ----------

describe('parseBackblazeGroupUsageCsv', () => {
  it('maps api_txn_class_d → classDTxn and gb fields → bytes', () => {
    const csv = [
      'date,group_id,account_id,bucket_id,reporting_location,stored_gb,uploaded_gb,downloaded_gb,api_txn_class_a,api_txn_class_b,api_txn_class_c,api_txn_class_d',
      '2026-05-26,g1,a1,b1,us-east-005,5,2,1,100,200,300,400',
    ].join('\n');
    const rows = parseBackblazeGroupUsageCsv(csv);
    expect(rows[0].classDTxn).toBe(400);
    expect(rows[0].storageBytes).toBe(5 * 1e9);
    expect(rows[0].egressBytes).toBe(1e9);
  });
});

// ---------- rollupBy ----------

describe('rollupBy', () => {
  it('sums class_d_txn alongside the other classes', () => {
    const rows = [
      { sub_account_id: 'a1', storage_bytes_avg: 100, class_a_txn: 1, class_b_txn: 2, class_c_txn: 3, class_d_txn: 4 },
      { sub_account_id: 'a1', storage_bytes_avg: 110, class_a_txn: 5, class_b_txn: 6, class_c_txn: 7, class_d_txn: 8 },
    ];
    const out = rollupBy(rows, 'sub_account_id');
    expect(out).toHaveLength(1);
    expect(out[0].class_d_txn).toBe(12);
    expect(out[0].class_a_txn).toBe(6);
    expect(out[0].storage_bytes_avg).toBe(110); // max, not sum
    expect(out[0].days).toBe(2);
  });
});

// ---------- activityFromCsv ----------

describe('activityFromCsv', () => {
  it('includes classD in per-row and total', () => {
    const rows = [
      { date: '2026-05-26', sub_account_id: 's', bucket_id: 'b1', bucket_name: 'n1', region: 'r',
        class_a_txn: 1, class_b_txn: 2, class_c_txn: 3, class_d_txn: 4 },
    ];
    const out = activityFromCsv(rows);
    expect(out[0].classD).toBe(4);
    expect(out[0].total).toBe(10);
  });
});

// ---------- buildUsageCsv round-trip ----------

describe('buildUsageCsv', () => {
  it('emits header + row with class_d_txn column', () => {
    const out = buildUsageCsv([{
      date: '2026-05-26', group_id: 'g', sub_account_id: 'a', bucket_id: 'b', bucket_name: 'n', region: 'r',
      storage_bytes_avg: 100, upload_bytes: 1, download_bytes: 2,
      class_a_txn: 3, class_b_txn: 4, class_c_txn: 5, class_d_txn: 6,
    }]);
    const lines = out.trim().split('\n');
    expect(lines[0]).toContain('class_d_txn');
    expect(lines[1].split(',').pop()).toBe('6');
  });
});

// ---------- estimateCost (B2 cost model with Class D) ----------

describe('estimateCost', () => {
  it('storage-only cost matches list price', () => {
    const c = estimateCost({ storageBytesAvg: 1e12, downloadBytes: 0, classDTxn: 0, days: 30 });
    expect(c.storageCost).toBeCloseTo(1000 * PRICING.storagePerGbMonth, 5);
    expect(c.egressCost).toBe(0);
    expect(c.classDCost).toBe(0);
  });

  it('egress under 3x stored is free', () => {
    const c = estimateCost({ storageBytesAvg: 1e9, downloadBytes: 2e9, classDTxn: 0 });
    expect(c.egressCost).toBe(0);
  });

  it('egress over 3x stored is billable', () => {
    // 1 GB stored, 4 GB egress → 1 GB billable at $0.01
    const c = estimateCost({ storageBytesAvg: 1e9, downloadBytes: 4e9, classDTxn: 0 });
    expect(c.egressCost).toBeCloseTo(0.01, 5);
  });

  it('classD under daily free tier is free', () => {
    // 30 days × 2500 free = 75,000 free events
    const c = estimateCost({ storageBytesAvg: 0, downloadBytes: 0, classDTxn: 1000, days: 30 });
    expect(c.classDCost).toBe(0);
  });

  it('classD over free tier is billed', () => {
    const c = estimateCost({ storageBytesAvg: 0, downloadBytes: 0, classDTxn: 75_000 + 10_000, days: 30 });
    expect(c.classDCost).toBeCloseTo(10_000 / 10_000 * PRICING.classDPer10k, 6);
  });

  it('total sums the three buckets', () => {
    const c = estimateCost({ storageBytesAvg: 1e12, downloadBytes: 5e12, classDTxn: 75_000 + 50_000 });
    expect(c.total).toBeCloseTo(c.storageCost + c.egressCost + c.classDCost, 5);
  });
});
