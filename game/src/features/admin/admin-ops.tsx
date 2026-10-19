import { useEffect, useState } from 'react';
import type { CompatibilityStatus } from '../../../shared/contracts/exports';
import { apiFetch } from '../auth/api-client';

export function AdminOps() {
  const [status, setStatus] = useState<CompatibilityStatus>();
  const [config, setConfig] = useState<unknown>();
  const [error, setError] = useState<string>();
  useEffect(() => { Promise.all([apiFetch<CompatibilityStatus>('/api/v1/exports/compatibility-status'), apiFetch('/api/v1/experiments/remote-config?appVersion=2.1.1')]).then(([nextStatus, nextConfig]) => { setStatus(nextStatus); setConfig(nextConfig); }).catch(cause => setError(cause.message)); }, []);
  return <main className="mx-auto min-h-screen max-w-5xl p-4 sm:p-8"><header className="rounded-[2rem] bg-gradient-to-r from-slate-900 to-purple-900 p-6 text-white shadow-xl"><p className="text-xs font-black uppercase tracking-widest text-purple-300">Operations</p><h1 className="mt-1 font-heading text-3xl font-black">🛠️ Live Service Console</h1></header>{error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 font-bold text-red-700">{error}</p>}<section className="mt-5 grid gap-4 md:grid-cols-2"><article className="min-w-0 rounded-3xl bg-white p-5 shadow"><h2 className="text-xl font-black">Dataset compatibility</h2><strong className="mt-3 block text-4xl text-purple-700">{status?.totalRows.toLocaleString() ?? '…'}</strong><p className="font-bold text-slate-500">rows · {status?.tables.length ?? 0}/13 tables</p><ul className="mt-4 grid grid-cols-2 gap-1 text-xs font-bold text-slate-600">{status?.tables.map(table => <li key={table.table}>{table.table}: {table.rows.toLocaleString()}</li>)}</ul></article><article className="min-w-0 rounded-3xl bg-white p-5 shadow"><h2 className="text-xl font-black">Remote config</h2><pre className="mt-3 max-h-80 overflow-auto rounded-xl bg-slate-950 p-3 text-xs text-green-300">{JSON.stringify(config, null, 2)}</pre></article></section></main>;
}
