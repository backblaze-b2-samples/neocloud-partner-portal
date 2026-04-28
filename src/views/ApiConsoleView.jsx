import React, { useMemo, useState } from 'react';
import { Terminal, Play, Copy, ExternalLink, Globe, ChevronDown } from 'lucide-react';
import { PageHeader, Card, CardHeader, Tag, SourceBadge, Tabs } from '../components/ui.jsx';
import { API_EXAMPLES } from '../data/apiExamples.js';
import { REGIONS, rewriteRegionInExample } from '../data/regions.js';

export default function ApiConsoleView() {
  const [selectedId, setSelectedId] = useState(API_EXAMPLES[0].id);
  const [regionId, setRegionId] = useState(REGIONS[0].id);
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);

  const region = useMemo(() => REGIONS.find((r) => r.id === regionId) || REGIONS[0], [regionId]);
  const baseExample = useMemo(() => API_EXAMPLES.find((e) => e.id === selectedId), [selectedId]);
  const example = useMemo(() => rewriteRegionInExample(baseExample, region), [baseExample, region]);
  const categories = useMemo(() => {
    const map = {};
    API_EXAMPLES.forEach((e) => {
      if (!map[e.category]) map[e.category] = [];
      map[e.category].push(e);
    });
    return map;
  }, []);

  function runRequest() {
    setLoading(true);
    setResponse(null);
    // In production, swap this for a real fetch using ../api/b2Adapter.js
    setTimeout(() => {
      setResponse(example.response);
      setLoading(false);
    }, 320);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Developer"
        title="API console"
        subtitle="Pick an endpoint, inspect the request shape, and see the structured response. Examples mirror real Backblaze API surfaces — Native API v4, Partner API v3, and the daily usage CSV report. Region selector rewrites region-specific hosts (api###, f###, s3.region) in the displayed URLs."
        actions={
          <div className="flex items-center gap-2">
            <RegionPicker regions={REGIONS} value={regionId} onChange={setRegionId} />
            <a
              href="https://www.backblaze.com/apidocs"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs text-ink-200 hover:bg-ink-800"
            >
              <ExternalLink size={12} /> Open API docs
            </a>
          </div>
        }
      />

      {/* Region context strip */}
      <div className="-mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-400">
        <span>
          Selected region <span className="font-mono text-ink-200">{region.flag} {region.code}</span> ·
          API host <code className="text-ink-200">{region.apiHost}</code> ·
          download host <code className="text-ink-200">{region.downloadHost}</code> ·
          S3 endpoint <code className="text-ink-200">{region.s3Endpoint}</code>
        </span>
      </div>
      {(example.id === 'authorize' || example.category === 'Partner') && (
        <div className="-mt-2 inline-flex items-center gap-2 rounded-md bg-accent-violet/10 px-2.5 py-1 text-[11px] text-accent-violet ring-1 ring-inset ring-accent-violet/30">
          <Globe size={11} />
          {example.id === 'authorize'
            ? 'b2_authorize_account is region-agnostic — it always hits api.backblazeb2.com. The response tells the client which region-specific apiUrl to use afterward.'
            : 'Partner API v3 calls go through api123.backblazeb2.com regardless of region.'}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        {/* Endpoint sidebar */}
        <Card padding="p-3">
          <CardHeader title="Endpoints" icon={<Terminal size={14} />} />
          <div className="space-y-3">
            {Object.entries(categories).map(([cat, items]) => (
              <div key={cat}>
                <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-400">
                  {cat}
                </div>
                <ul className="space-y-0.5">
                  {items.map((e) => {
                    const active = e.id === selectedId;
                    return (
                      <li key={e.id}>
                        <button
                          onClick={() => { setSelectedId(e.id); setResponse(null); }}
                          className={
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ' +
                            (active
                              ? 'bg-bb-red/10 text-ink-100 ring-1 ring-inset ring-bb-red/30'
                              : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100')
                          }
                        >
                          <Method method={e.request.method} small />
                          <span className="truncate">{e.name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </Card>

        <div className="space-y-4">
          {/* Request panel */}
          <Card>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Method method={example.request.method} />
                  <code className="truncate text-xs text-ink-100">{example.request.url}</code>
                </div>
                <h3 className="mt-2 text-sm font-semibold text-ink-100">{example.name}</h3>
                <p className="mt-1 text-xs text-ink-300">{example.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Tag>{example.category}</Tag>
                <button
                  onClick={runRequest}
                  className="inline-flex items-center gap-1 rounded-md bg-bb-red px-3 py-1.5 text-xs font-medium text-white shadow-glow hover:bg-bb-redDim"
                >
                  <Play size={12} /> Run demo request
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <SubBlock title="Headers">
                <CodeBlock language="http">
                  {Object.entries(example.request.headers)
                    .map(([k, v]) => `${k}: ${v}`).join('\n')}
                </CodeBlock>
              </SubBlock>
              <SubBlock title="Body">
                {example.request.body ? (
                  <CodeBlock language="json">
                    {JSON.stringify(example.request.body, null, 2)}
                  </CodeBlock>
                ) : (
                  <CodeBlock language="text">{'(no body — GET request)'}</CodeBlock>
                )}
              </SubBlock>
            </div>
          </Card>

          {/* Response panel */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink-100">Response</h3>
                <p className="mt-0.5 text-xs text-ink-300">
                  {response
                    ? `HTTP ${response.status} — example payload returned by Backblaze`
                    : 'Click "Run demo request" to load the example response'}
                </p>
              </div>
              <SourceBadge source="demo" />
            </div>
            {loading ? (
              <div className="flex h-48 items-center justify-center text-xs text-ink-400">
                Sending request to {example.request.url.split('/')[2]}…
              </div>
            ) : response ? (
              <ResponseView response={response} />
            ) : (
              <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-ink-700 text-xs text-ink-400">
                No response yet
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function ResponseView({ response }) {
  const [tab, setTab] = useState('json');
  const isJson = typeof response.body === 'object';
  const tabs = isJson
    ? [{ id: 'json', label: 'JSON' }, { id: 'raw', label: 'Raw' }]
    : [{ id: 'raw', label: 'Raw' }];
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={"rounded px-2 py-0.5 text-[11px] font-mono ring-1 " + (response.status < 300 ? "bg-accent-green/10 text-accent-green ring-accent-green/30" : "bg-bb-red/10 text-bb-red ring-bb-red/30")}>
            {response.status} {response.status < 300 ? 'OK' : 'Error'}
          </span>
          <Tabs tabs={tabs} value={tab} onChange={setTab} />
        </div>
        <button
          onClick={() => navigator.clipboard?.writeText(typeof response.body === 'string' ? response.body : JSON.stringify(response.body, null, 2))}
          className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-800 hover:text-ink-100"
        >
          <Copy size={11} /> Copy
        </button>
      </div>
      {tab === 'json' && isJson ? (
        <CodeBlock language="json">
          <JsonRender value={response.body} />
        </CodeBlock>
      ) : (
        <CodeBlock language="text">
          {typeof response.body === 'string' ? response.body : JSON.stringify(response.body, null, 2)}
        </CodeBlock>
      )}
    </div>
  );
}

// Pretty-print JSON with light syntax highlighting
function JsonRender({ value }) {
  const text = JSON.stringify(value, null, 2);
  // Lightweight token highlighter for keys / strings / numbers / booleans
  const html = text
    .replace(/("(?:\\.|[^"\\])*")(\s*:)/g, '<span class="text-accent-teal">$1</span>$2')
    .replace(/: ("(?:\\.|[^"\\])*")/g, ': <span class="text-accent-amber">$1</span>')
    .replace(/: (true|false|null)/g, ': <span class="text-accent-violet">$1</span>')
    .replace(/: (-?\d+(?:\.\d+)?)/g, ': <span class="text-accent-green">$1</span>');
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function SubBlock({ title, children }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-widest text-ink-400">{title}</div>
      {children}
    </div>
  );
}

function CodeBlock({ children, language }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-ink-950/80 p-3 text-[11.5px] leading-relaxed text-ink-200 ring-1 ring-ink-700">
      <code className={language ? `language-${language}` : ''}>{children}</code>
    </pre>
  );
}

function RegionPicker({ regions, value, onChange }) {
  return (
    <div className="relative">
      <Globe size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
      <ChevronDown size={12} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 cursor-pointer appearance-none rounded-md border border-ink-700 bg-ink-850 pl-7 pr-7 text-xs font-medium text-ink-100 focus:border-bb-red/50 focus:outline-none focus:ring-1 focus:ring-bb-red/40"
        title="Rewrites api###/f###/s3.region hosts in the displayed examples"
      >
        {regions.map((r) => (
          <option key={r.id} value={r.id}>{r.flag} {r.code}</option>
        ))}
      </select>
    </div>
  );
}

function Method({ method, small }) {
  const colors = {
    GET: 'bg-accent-teal/15 text-accent-teal ring-accent-teal/30',
    POST: 'bg-accent-violet/15 text-accent-violet ring-accent-violet/30',
    PUT: 'bg-accent-amber/15 text-accent-amber ring-accent-amber/30',
    DELETE: 'bg-bb-red/15 text-bb-red ring-bb-red/30',
  }[method] || 'bg-ink-700 text-ink-200 ring-ink-600';
  return (
    <span className={
      'inline-flex items-center rounded font-mono font-semibold ring-1 ring-inset ' + colors + ' ' +
      (small ? 'px-1 py-0 text-[9px]' : 'px-1.5 py-0.5 text-[10.5px]')
    }>
      {method}
    </span>
  );
}
