import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TeachingAnalyticsSnapshot } from '../../../shared/contracts/telemetry';
import { apiFetch } from '../auth/api-client';

export function TeachingLab() {
  const [snapshot, setSnapshot] = useState<TeachingAnalyticsSnapshot>();
  const [error, setError] = useState<string>();
  useEffect(() => { apiFetch<TeachingAnalyticsSnapshot>('/api/v1/analytics/teaching-snapshot').then(setSnapshot).catch(cause => setError(cause.message)); }, []);
  const affected = useMemo(() => snapshot?.tutorialStep4.find(row => row.appVersion === '2.1.0' && row.platform === 'Android' && row.region === 'SEA'), [snapshot]);
  if (error) return <Panel title="Không tải được analytics"><p role="alert">{error}</p></Panel>;
  if (!snapshot) return <Panel title="Đang materialize dữ liệu…"><p>📊 Đang đọc 13 bảng tương thích.</p></Panel>;
  return (
    <main className="mx-auto min-h-screen max-w-6xl p-4 sm:p-8">
      <header className="rounded-[2rem] bg-[#23395B] p-6 text-white shadow-xl"><p className="text-xs font-black uppercase tracking-widest text-cyan-300">Analyst Workbench</p><h1 className="mt-1 font-heading text-3xl font-black">📊 Product Health Lab</h1><p className="mt-2 font-bold text-white/75">{snapshot.dataset ? `Nguồn: ${snapshot.dataset.totalRows.toLocaleString('vi-VN')} dòng · Jelly Trail Academy v${snapshot.dataset.version} · ${snapshot.dataset.synthetic ? 'Dữ liệu giả lập để dạy học, không phải người chơi thật' : 'Dataset đã nhập'}` : 'Chưa có manifest dataset được nhập'}</p></header>
      <section className="mt-5 grid gap-3 sm:grid-cols-3"><Metric label="Step 4 · Android SEA · v2.1.0" value={`${((affected?.completionRate ?? 0) * 100).toFixed(1)}%`} tone="red" /><Metric label="Dữ liệu ngày" value={`${snapshot.dailyKpi.length} ngày`} tone="blue" /><Metric label="Segment level friction" value={`${snapshot.levelFriction.length}`} tone="amber" /></section>
      <section className="mt-6 rounded-3xl bg-white p-5 shadow-lg"><h2 className="text-xl font-black">Tutorial step 4 completion</h2><div className="mt-4 space-y-3">{snapshot.tutorialStep4.filter(row => row.platform === 'Android' && row.region === 'SEA').map(row => <Bar key={row.appVersion} label={row.appVersion} value={row.completionRate} />)}</div><p className="mt-4 rounded-xl bg-blue-50 p-3 text-sm font-bold text-blue-800">So sánh cùng phân khúc giữa các phiên bản. Giải thích bằng số liệu và mẫu quan sát, không suy ra quan hệ nhân quả chỉ từ biểu đồ.</p></section>
      <section className="mt-6 overflow-x-auto rounded-3xl bg-white p-5 shadow-lg"><h2 className="text-xl font-black">Levels 28–30 fail heatmap</h2><table className="mt-3 w-full min-w-[620px] text-left text-sm"><thead><tr className="text-slate-500"><th className="p-2">Version</th><th>Platform</th><th>Region</th><th>Win</th><th>Non-complete</th><th>Attempts</th></tr></thead><tbody>{snapshot.levelFriction.map(row => <tr key={`${row.appVersion}-${row.platform}-${row.region}`} className={row.appVersion === '2.1.0' && row.platform === 'Android' && row.region === 'SEA' ? 'bg-red-50 font-black text-red-800' : 'border-t'}><td className="p-2">{row.appVersion}</td><td>{row.platform}</td><td>{row.region}</td><td>{(row.winRate * 100).toFixed(1)}%</td><td>{(row.nonCompleteRate * 100).toFixed(1)}%</td><td>{row.attempts.toLocaleString()}</td></tr>)}</tbody></table></section>
    </main>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) { return <main className="min-h-[80vh] p-6 flex items-center justify-center"><section className="rounded-3xl bg-white p-8 shadow-xl"><h1 className="text-xl font-black">{title}</h1>{children}</section></main>; }
function Metric({ label, value, tone }: { label: string; value: string; tone: 'red' | 'blue' | 'amber' }) { const color = { red: 'border-red-300 text-red-700', blue: 'border-blue-300 text-blue-700', amber: 'border-amber-300 text-amber-700' }[tone]; return <article className={`rounded-3xl border-2 bg-white p-5 shadow ${color}`}><p className="text-xs font-black uppercase">{label}</p><strong className="mt-2 block text-3xl">{value}</strong></article>; }
function Bar({ label, value }: { key?: string; label: string; value: number }) { return <div><div className="flex justify-between text-sm font-black"><span>{label}</span><span>{(value * 100).toFixed(1)}%</span></div><div className="mt-1 h-4 overflow-hidden rounded-full bg-slate-100"><div className={`h-full ${label === '2.1.0' ? 'bg-red-500' : 'bg-green-500'}`} style={{ width: `${value * 100}%` }} /></div></div>; }
