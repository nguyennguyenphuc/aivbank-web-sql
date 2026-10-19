import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AnalysisEvidenceCard, AnalysisJourney, AnalysisStepResponse } from '../../../shared/contracts/classroom';
import { classroomApi } from './classroom-api';

interface AnalysisJourneyProps {
  initialJourney: AnalysisJourney;
  onChanged: (journey: AnalysisJourney) => void;
  onClose: () => void;
}

const EMPTY_RESPONSE: AnalysisStepResponse = { narrative: '', evidenceIds: [] };

export function AnalysisJourneyWorkspace({ initialJourney, onChanged, onClose }: AnalysisJourneyProps) {
  const [journey, setJourney] = useState(initialJourney);
  const [activeStep, setActiveStep] = useState(Math.min(initialJourney.attempt.currentStep, initialJourney.scenario.journeySteps.length - 1));
  const [draft, setDraft] = useState<AnalysisStepResponse>(() => responseAt(initialJourney, activeStep));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const changeVersion = useRef(0);
  const savingRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const step = journey.scenario.journeySteps[activeStep];
  const relevantEvidence = useMemo(() => journey.evidence.filter(item => step?.evidenceCategories.includes(item.category)), [journey.evidence, step]);

  const updateDraft = (updater: (current: AnalysisStepResponse) => AnalysisStepResponse) => {
    changeVersion.current += 1;
    setDraft(current => {
      const next = updater(current);
      draftRef.current = next;
      return next;
    });
    setDirty(true);
    setMessage(undefined);
  };

  const saveCurrent = useCallback(async (nextStep = activeStep): Promise<AnalysisJourney | undefined> => {
    if (!step || savingRef.current || journey.attempt.status === 'submitted') return undefined;
    savingRef.current = true;
    setSaving(true);
    const versionAtStart = changeVersion.current;
    const responseAtStart = draftRef.current;
    try {
      const updated = await classroomApi.saveStep(journey.assignment.assignmentId, step.stepId, {
        expectedRevision: journey.attempt.revision,
        currentStep: nextStep,
        response: responseAtStart,
      });
      setJourney(updated);
      onChanged(updated);
      if (changeVersion.current === versionAtStart) {
        setDirty(false);
        setMessage('Đã lưu bản nháp.');
      } else {
        setMessage('Bạn có thay đổi mới chưa được lưu.');
      }
      return updated;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không thể lưu bản nháp');
      return undefined;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [activeStep, journey.assignment.assignmentId, journey.attempt.revision, journey.attempt.status, onChanged, step]);

  useEffect(() => {
    if (!dirty || journey.attempt.status === 'submitted') return;
    const timer = window.setTimeout(() => { void saveCurrent(activeStep); }, 900);
    return () => window.clearTimeout(timer);
  }, [activeStep, dirty, draft, journey.attempt.status, saveCurrent]);

  if (!step) return <WorkspaceShell onClose={onClose}><p role="alert">Scenario chưa có journey hợp lệ.</p></WorkspaceShell>;
  if (journey.result) return <ResultView journey={journey} onClose={onClose} />;

  const navigate = async (nextIndex: number) => {
    const bounded = Math.max(0, Math.min(journey.scenario.journeySteps.length - 1, nextIndex));
    const versionAtNavigation = changeVersion.current;
    const updated = await saveCurrent(bounded);
    if (!updated) return;
    if (changeVersion.current !== versionAtNavigation) return;
    const source = updated;
    setActiveStep(bounded);
    const nextResponse = responseAt(source, bounded);
    draftRef.current = nextResponse;
    setDraft(nextResponse);
    setDirty(false);
  };

  const submit = async () => {
    setMessage(undefined);
    const versionAtSubmission = changeVersion.current;
    const updated = await saveCurrent(activeStep);
    if (!updated) return;
    if (changeVersion.current !== versionAtSubmission) return;
    try {
      const submitted = await classroomApi.submit(journey.assignment.assignmentId);
      setJourney(submitted);
      onChanged(submitted);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Không thể nộp bài'); }
  };

  return (
    <WorkspaceShell onClose={onClose}>
      <header className="rounded-3xl bg-gradient-to-r from-[#23395B] to-[#315F8A] p-5 text-white">
        <p className="text-xs font-black uppercase tracking-widest">Analysis Journey · {journey.scenario.estimatedMinutes} phút</p>
        <h1 className="mt-1 text-2xl font-black">{journey.assignment.title}</h1>
        <p className="mt-2 text-sm font-semibold text-white/80">{journey.scenario.description}</p>
        <div className="mt-4 h-3 overflow-hidden rounded-full bg-white/20" aria-label={`Tiến độ ${activeStep + 1} trên ${journey.scenario.journeySteps.length}`}>
          <div className="h-full rounded-full bg-[#FFCF4D] transition-all" style={{ width: `${((activeStep + 1) / journey.scenario.journeySteps.length) * 100}%` }} />
        </div>
      </header>

      <nav aria-label="Các bước phân tích" className="mt-4 flex gap-2 overflow-x-auto pb-2">
        {journey.scenario.journeySteps.map((item, index) => {
          const answered = Boolean(journey.attempt.responses[item.stepId]?.narrative.trim());
          return <button key={item.stepId} id={`analysis-step-${item.stepId}`} onClick={() => void navigate(index)} disabled={saving} aria-current={index === activeStep ? 'step' : undefined} className={`min-w-12 rounded-xl px-3 py-2 text-sm font-black ${index === activeStep ? 'bg-[#5EADFF] text-white' : answered ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-500'}`}>{index + 1}</button>;
        })}
      </nav>

      <section className="mt-4 rounded-3xl bg-white p-5 shadow-lg">
        <p className="text-xs font-black uppercase tracking-widest text-[#8B7CFF]">Bước {activeStep + 1}/10</p>
        <h2 className="mt-1 text-2xl font-black text-[#23395B]">{step.title}</h2>
        <p className="mt-3 font-bold text-slate-700">{step.prompt}</p>
        <p className="mt-2 rounded-xl bg-[#FFF7D6] p-3 text-sm font-semibold text-[#6E5214]">💡 {step.guidance}</p>

        <label htmlFor="analysis-narrative" className="mt-5 block text-sm font-black text-slate-700">Lập luận của bạn</label>
        <textarea id="analysis-narrative" data-testid="analysis-narrative" value={draft.narrative} onChange={event => updateDraft(current => ({ ...current, narrative: event.target.value }))} rows={7} maxLength={4000} placeholder="Nêu claim → evidence → reasoning → uncertainty…" className="mt-2 w-full rounded-2xl border-2 border-blue-100 p-4 font-semibold text-slate-800 outline-none focus:border-blue-400" />
        <div className="mt-1 flex justify-between text-xs font-bold text-slate-400"><span>Tối thiểu {step.minNarrativeLength} ký tự</span><span>{draft.narrative.trim().length}/4000</span></div>
      </section>

      <section className="mt-4 rounded-3xl bg-white p-5 shadow-lg">
        <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-black text-[#315F8A]">Evidence cards</h2><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-700">Chọn ≥ {step.minEvidenceCount}</span></div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {relevantEvidence.map(item => {
            const selected = draft.evidenceIds.includes(item.evidenceId);
            return <button key={item.evidenceId} data-testid={`evidence-${item.evidenceId}`} aria-pressed={selected} onClick={() => updateDraft(current => ({ ...current, evidenceIds: current.evidenceIds.includes(item.evidenceId) ? current.evidenceIds.filter(id => id !== item.evidenceId) : [...current.evidenceIds, item.evidenceId] }))} className={`rounded-2xl border-2 p-4 text-left transition ${selected ? 'border-[#5EADFF] bg-blue-50 shadow' : 'border-slate-100 bg-slate-50'}`}>
              <div className="flex items-start justify-between gap-2"><span className="text-xs font-black uppercase text-slate-500">{item.category}</span><Maturity maturity={item.maturity} /></div>
              <strong className="mt-2 block text-sm text-slate-700">{item.label}</strong>
              <span className="mt-1 block text-2xl font-black text-[#23395B]">{formatEvidence(item)}</span>
              <span className="mt-1 block text-xs font-semibold text-slate-500">{item.segment}{item.sampleSize !== undefined ? ` · n=${item.sampleSize.toLocaleString()}` : ''}</span>
              {item.note && <span className="mt-2 block text-xs font-bold text-amber-700">{item.note}</span>}
            </button>;
          })}
        </div>
      </section>

      {message && <p role="status" className={`mt-4 rounded-xl p-3 text-center font-bold ${message.startsWith('Đã') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{message}</p>}
      <footer className="sticky bottom-16 mt-5 grid grid-cols-2 gap-3 rounded-3xl bg-white/95 p-3 shadow-2xl backdrop-blur sm:grid-cols-4">
        <button onClick={() => void navigate(activeStep - 1)} disabled={activeStep === 0 || saving} className="rounded-xl bg-slate-100 px-4 py-3 font-black text-slate-600 disabled:opacity-40">← Trước</button>
        <button onClick={() => void saveCurrent(activeStep)} disabled={saving} className="rounded-xl bg-blue-100 px-4 py-3 font-black text-blue-800">{saving ? 'Đang lưu…' : dirty ? 'Lưu nháp' : 'Đã lưu'}</button>
        {activeStep < journey.scenario.journeySteps.length - 1 ? <button onClick={() => void navigate(activeStep + 1)} disabled={saving} className="rounded-xl bg-[#5EADFF] px-4 py-3 font-black text-white">Tiếp →</button> : <button data-testid="submit-analysis" onClick={() => void submit()} disabled={saving} className="rounded-xl bg-[#71B15A] px-4 py-3 font-black text-white">Nộp bài</button>}
        <button onClick={onClose} className="rounded-xl bg-slate-800 px-4 py-3 font-black text-white">Về lớp</button>
      </footer>
    </WorkspaceShell>
  );
}

function ResultView({ journey, onClose }: { journey: AnalysisJourney; onClose: () => void }) {
  const result = journey.result!;
  return <WorkspaceShell onClose={onClose}><section data-testid="analysis-result" className="rounded-[2rem] bg-white p-6 text-center shadow-xl"><div className="text-6xl">🎓</div><p className="mt-3 text-xs font-black uppercase tracking-widest text-green-600">Đã nộp analysis journey</p><h1 className="mt-1 text-3xl font-black text-[#23395B]">{result.score}/{result.maxScore}</h1><p className="mt-2 font-semibold text-slate-600">Nộp lúc {new Date(result.submittedAt).toLocaleString('vi-VN')}</p><div className="mt-6 grid gap-3 sm:grid-cols-3">{result.dimensions.map(item => <article key={item.dimension} className="rounded-2xl bg-slate-50 p-4 text-left"><p className="text-xs font-black uppercase text-slate-500">{item.dimension}</p><strong className="mt-1 block text-2xl text-[#315F8A]">{item.score}/{item.maxScore}</strong><p className="mt-2 text-xs font-semibold text-slate-600">{item.feedback}</p></article>)}</div><div className="mt-5 grid gap-4 text-left md:grid-cols-2"><ResultList title="Điểm mạnh" items={result.strengths} tone="green" /><ResultList title="Bước tiếp theo" items={result.nextSteps} tone="amber" /></div><button onClick={onClose} className="mt-6 rounded-xl bg-[#5EADFF] px-6 py-3 font-black text-white">Về danh sách bài</button></section></WorkspaceShell>;
}

function WorkspaceShell({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return <main className="mx-auto min-h-screen max-w-6xl p-4 pb-28 sm:p-8"><button onClick={onClose} className="mb-3 rounded-xl bg-white px-4 py-2 font-black text-slate-600 shadow">← Lớp học</button>{children}</main>;
}

function ResultList({ title, items, tone }: { title: string; items: string[]; tone: 'green' | 'amber' }) {
  return <section className={`rounded-2xl p-4 ${tone === 'green' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}><h2 className="font-black">{title}</h2><ul className="mt-2 list-inside list-disc text-sm font-semibold">{items.map(item => <li key={item}>{item}</li>)}</ul></section>;
}

function Maturity({ maturity }: { maturity: AnalysisEvidenceCard['maturity'] }) {
  const copy = { ready: 'Đủ mẫu', limited: 'Mẫu nhỏ', missing: 'Thiếu data' }[maturity];
  const tone = { ready: 'bg-green-100 text-green-700', limited: 'bg-amber-100 text-amber-700', missing: 'bg-red-100 text-red-700' }[maturity];
  return <span className={`rounded-full px-2 py-1 text-[10px] font-black ${tone}`}>{copy}</span>;
}

function formatEvidence(item: AnalysisEvidenceCard): string {
  if (item.value === null) return 'Chưa có dữ liệu';
  if (typeof item.value === 'string') return item.value;
  if (item.unit === 'percent') return `${item.value.toFixed(1)}%`;
  if (item.unit === 'currency') return `$${item.value.toFixed(3)}`;
  return item.value.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
}

function responseAt(journey: AnalysisJourney, index: number): AnalysisStepResponse {
  const stepId = journey.scenario.journeySteps[index]?.stepId;
  const response = stepId ? journey.attempt.responses[stepId] : undefined;
  return response ? { narrative: response.narrative, evidenceIds: [...response.evidenceIds] } : { ...EMPTY_RESPONSE, evidenceIds: [] };
}
