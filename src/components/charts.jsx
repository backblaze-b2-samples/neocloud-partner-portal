// Chart wrappers — line, area, stacked bar, donut, sparkline, heatmap.

import React from 'react';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend,
} from 'recharts';
import { bytes, compactNumber, shortDate } from '../lib/format.js';

const RED = '#E61F18';
const TEAL = '#3DD9D6';
const VIOLET = '#9B7CFF';
const AMBER = '#F5B73E';
const GREEN = '#2BD68A';
export const CHART_COLORS = [RED, TEAL, VIOLET, AMBER, GREEN];

// =============================================================================
// Sparkline — small inline trend
// =============================================================================
export function Sparkline({ data = [], dataKey = 'value', color = RED, height = 44 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`spark-${dataKey}-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.6}
          fill={`url(#spark-${dataKey}-${color})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// =============================================================================
// Daily area chart — used for storage / egress trend
// =============================================================================
export function TrendAreaChart({
  data,
  series,        // [{ key, name, color, format }]
  height = 240,
  yFormatter = compactNumber,
  xKey = 'date',
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.42} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1F2638" vertical={false} />
        <XAxis dataKey={xKey} tickFormatter={(v) => (typeof v === 'string' && v.length === 10 ? shortDate(v) : v)} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={yFormatter} tickLine={false} axisLine={false} width={56} />
        <Tooltip
          contentStyle={{ background: '#10141F', border: '1px solid #2A334B', borderRadius: 8 }}
          formatter={(v, n, p) => {
            const s = series.find((x) => x.key === p.dataKey);
            return [s?.format ? s.format(v) : yFormatter(v), s?.name || n];
          }}
          labelFormatter={(v) => (typeof v === 'string' && v.length === 10 ? shortDate(v) : v)}
        />
        {series.length > 1 && (
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        )}
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={1.8}
            fill={`url(#grad-${s.key})`}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

// =============================================================================
// Stacked bar chart
// =============================================================================
export function StackedBarChart({ data, series, height = 240, xKey = 'name', yFormatter = compactNumber }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1F2638" vertical={false} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={yFormatter} tickLine={false} axisLine={false} width={56} />
        <Tooltip
          contentStyle={{ background: '#10141F', border: '1px solid #2A334B', borderRadius: 8 }}
          formatter={(v, n, p) => {
            const s = series.find((x) => x.key === p.dataKey);
            return [s?.format ? s.format(v) : yFormatter(v), s?.name || n];
          }}
        />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            stackId="stack"
            fill={s.color}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// =============================================================================
// Donut chart — region/customer share
// =============================================================================
export function DonutChart({ data, dataKey = 'value', nameKey = 'name', height = 220, formatter = bytes }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey={dataKey}
          nameKey={nameKey}
          innerRadius={50}
          outerRadius={86}
          paddingAngle={2}
          isAnimationActive={false}
          stroke="#0B0E16"
          strokeWidth={2}
        >
          {data.map((d, i) => (
            <Cell key={i} fill={d.color || CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ background: '#10141F', border: '1px solid #2A334B', borderRadius: 8 }}
          formatter={(v) => formatter(v)}
        />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
          layout="vertical"
          align="right"
          verticalAlign="middle"
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// =============================================================================
// Heatmap — 14 days x 24 hours
// =============================================================================
export function Heatmap({ cells, days = 14, hours = 24 }) {
  // cells: [{ day, hour, value }]
  const grid = Array.from({ length: days }, () => new Array(hours).fill(0));
  cells.forEach((c) => {
    if (c.day < days && c.hour < hours) grid[c.day][c.hour] = c.value;
  });
  return (
    <div className="overflow-x-auto">
      <div className="inline-flex flex-col gap-[3px]">
        {/* Header row of hours */}
        <div className="flex gap-[3px] pl-9">
          {Array.from({ length: hours }, (_, h) => (
            <div key={h} className="h-3 w-4 text-center text-[9px] text-ink-400">
              {h % 6 === 0 ? `${h}h` : ''}
            </div>
          ))}
        </div>
        {grid.map((row, d) => (
          <div key={d} className="flex items-center gap-[3px]">
            <div className="w-9 pr-1 text-right text-[10px] text-ink-400">D−{days - d - 1}</div>
            {row.map((v, h) => (
              <div
                key={h}
                title={`Day −${days - d - 1}, ${h}:00 — ${(v * 100).toFixed(0)}%`}
                className="h-4 w-4 rounded-[3px] ring-1 ring-inset ring-ink-700/60"
                style={{
                  background: heatColor(v),
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-[10px] text-ink-400">
        <span>Low</span>
        <div className="flex gap-[2px]">
          {[0.05, 0.2, 0.4, 0.6, 0.8, 1].map((v) => (
            <div key={v} className="h-3 w-4 rounded-[2px]" style={{ background: heatColor(v) }} />
          ))}
        </div>
        <span>High</span>
      </div>
    </div>
  );
}
function heatColor(v) {
  // Backblaze red ramp
  if (v < 0.05) return '#10141F';
  const a = Math.min(1, 0.10 + v * 0.85);
  return `rgba(230, 31, 24, ${a})`;
}
