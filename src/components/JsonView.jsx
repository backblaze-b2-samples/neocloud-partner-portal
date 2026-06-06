// Reusable JSON syntax-highlighter — keys teal, strings amber, numbers green,
// booleans/null violet. Used by the API console, the training API-activity
// drawer, and the MCP console.
import React from 'react';
import { cx } from '../lib/format.js';

const COLOR = {
  key: 'text-accent-teal',
  string: 'text-accent-amber',
  number: 'text-accent-green',
  literal: 'text-accent-violet', // true / false / null
};

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlight(jsonText) {
  return escapeHtml(jsonText).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = COLOR.number;
      if (/^"/.test(match)) cls = /:$/.test(match.trim()) ? COLOR.key : COLOR.string;
      else if (/^(true|false|null)$/.test(match)) cls = COLOR.literal;
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

export function JsonView({ value, className }) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = 'undefined';
  return (
    <pre className={cx('overflow-x-auto rounded-md bg-ink-950/60 p-3 font-mono text-[11.5px] leading-relaxed text-ink-200 ring-1 ring-ink-800', className)}>
      <code dangerouslySetInnerHTML={{ __html: highlight(text) }} />
    </pre>
  );
}
