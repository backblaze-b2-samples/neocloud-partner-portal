// Time-series usage metrics. In production, these are derived from the
// daily usage CSV report (see ../api/csvParser.js). The Backblaze Native
// API does not expose aggregated storage / egress / transaction counts.
//
// Source for production: b2-reports-$ACCOUNTID bucket, YYYY-MM-DD/Usage.csv
// Reference: https://www.backblaze.com/docs/cloud-storage-use-partner-api-reports

import { REGIONS } from './regions.js';

// Last 30 days, one entry per day. Values are realistic for a multi-PB
// reseller with steady growth and a couple of usage spikes.
function generateDailyUsage(days = 30) {
  const today = new Date('2026-04-25T00:00:00Z');
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    // Storage trends up gently
    const baseStorage = 52e15 + i * -0.18e15 + Math.sin(i / 4) * 0.4e15;
    // Egress varies with workload — spikes on weekends for streaming
    const dow = d.getUTCDay();
    const egressMul = dow === 0 || dow === 6 ? 1.4 : 1.0;
    const egressBase = (0.61e15 + Math.sin(i / 3) * 0.12e15) * egressMul;
    // Uploads steadier
    const uploadBase = 0.34e15 + Math.cos(i / 5) * 0.08e15;
    out.push({
      date: d.toISOString().slice(0, 10),
      storageBytes: Math.round(baseStorage),
      egressBytes: Math.round(egressBase),
      uploadBytes: Math.round(uploadBase),
      classATxn: Math.round(140_000_000 + Math.sin(i / 4) * 22_000_000),
      classBTxn: Math.round(110_000_000 + Math.sin(i / 3) * 28_000_000),
      classCTxn: Math.round(4_800_000 + Math.cos(i / 5) * 900_000),
      classDTxn: Math.round(3_200_000 + Math.sin(i / 6) * 600_000),
    });
  }
  return out;
}

export const DAILY_USAGE = generateDailyUsage(30);

// Per-region monthly aggregates (derived from daily CSV rolled up by region).
// Each B2 account is single-region; partner aggregates across accounts.
export const REGION_USAGE = REGIONS.map((r, i) => {
  const weights = [0.42, 0.31, 0.13, 0.14]; // distribution of total
  const w = weights[i];
  const total = DAILY_USAGE.reduce(
    (acc, d) => {
      acc.storage = Math.max(acc.storage, d.storageBytes);
      acc.egress += d.egressBytes;
      acc.upload += d.uploadBytes;
      acc.classA += d.classATxn;
      acc.classB += d.classBTxn;
      acc.classC += d.classCTxn;
      acc.classD += d.classDTxn || 0;
      return acc;
    },
    { storage: 0, egress: 0, upload: 0, classA: 0, classB: 0, classC: 0, classD: 0 }
  );
  return {
    regionId: r.id,
    code: r.code,
    storageBytes: total.storage * w,
    egressBytes30d: total.egress * w,
    uploadBytes30d: total.upload * w,
    classATxn30d: total.classA * w,
    classBTxn30d: total.classB * w,
    classCTxn30d: total.classC * w,
    classDTxn30d: total.classD * w,
    bucketCount: [89, 64, 23, 14][i],
    growth30d: [0.124, 0.082, 0.041, 0.156][i],
    // p99 latency and availability are NOT exposed by any Backblaze API.
    // Surface them only if you run external probes (Datadog, Catchpoint, etc.).
  };
});

// 14-day x 24-hour heatmap: API request volume per hour, per day.
// Used in Storage / API view. Values normalized 0..1.
export const ACTIVITY_HEATMAP = (() => {
  const cells = [];
  for (let day = 0; day < 14; day++) {
    for (let hour = 0; hour < 24; hour++) {
      // Workday uplift, weekend down
      const dow = (day + 2) % 7; // arbitrary day alignment
      const isWeekend = dow === 0 || dow === 6;
      const businessHourUplift = hour >= 8 && hour <= 19 ? 0.55 : 0.18;
      const noise = (Math.sin(day * 11 + hour * 3) + 1) / 8;
      const value = Math.min(1, (isWeekend ? 0.28 : 0.62) * businessHourUplift + noise);
      cells.push({ day, hour, value });
    }
  }
  return cells;
})();
