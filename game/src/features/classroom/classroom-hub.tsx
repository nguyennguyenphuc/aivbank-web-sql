import { useEffect, useState, type FormEvent } from 'react';
import type { SessionPrincipal } from '../../../shared/contracts/auth';
import type {
  AnalysisJourney,
  ClassroomMembershipSummary,
  ScenarioPack,
  TeacherAssignmentDashboard,
  TeachingAssignmentSummary,
} from '../../../shared/contracts/classroom';
import { AnalysisJourneyWorkspace } from './analysis-journey';
import { classroomApi } from './classroom-api';

export function ClassroomHub({ principal }: { principal: SessionPrincipal }) {
  const [scenarios, setScenarios] = useState<ScenarioPack[]>([]);
  const [classrooms, setClassrooms] = useState<ClassroomMembershipSummary[]>([]);
  const [assignments, setAssignments] = useState<TeachingAssignmentSummary[]>([]);
  const [teacherAssignments, setTeacherAssignments] = useState<Record<string, TeachingAssignmentSummary[]>>({});
  const [activeJourney, setActiveJourney] = useState<AnalysisJourney>();
  const [dashboard, setDashboard] = useState<TeacherAssignmentDashboard>();
  const [joinCode, setJoinCode] = useState('');
  const [name, setName] = useState('Lớp phân tích Match-3');
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(true);
  const canTeach = principal.roles.some(role => role === 'instructor' || role === 'admin');

  const refresh = async () => {
    setLoading(true);
    try {
      const [nextScenarios, nextClassrooms, nextAssignments] = await Promise.all([
        classroomApi.scenarios(), classroomApi.mine(), classroomApi.assignments(),
      ]);
      setScenarios(nextScenarios);
      setClassrooms(nextClassrooms);
      setAssignments(nextAssignments);
      if (canTeach) {
        const owned = nextClassrooms.filter(item => item.membershipRole === 'teacher');
        const pairs = await Promise.all(owned.map(async classroom => [classroom.classroomId, await classroomApi.teacherAssignments(classroom.classroomId)] as const));
        setTeacherAssignments(Object.fromEntries(pairs));
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Không tải được lớp học'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const join = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const classroom = await classroomApi.join(joinCode);
      setJoinCode('');
      setMessage(`Đã vào lớp ${classroom.name}.`);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Không thể vào lớp'); }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const classroom = await classroomApi.create(name);
      setMessage(`Đã tạo lớp ${classroom.name} · mã ${classroom.joinCode}`);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Không thể tạo lớp'); }
  };

  const openAssignment = async (assignment: TeachingAssignmentSummary) => {
    setMessage(undefined);
    try {
      const journey = assignment.attemptStatus === 'not_started' ? await classroomApi.start(assignment.assignmentId) : await classroomApi.journey(assignment.assignmentId);
      setActiveJourney(journey);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Không thể mở bài phân tích'); }
  };

  const openProgress = async (assignment: TeachingAssignmentSummary) => {
    try { setDashboard(await classroomApi.progress(assignment.classroomId, assignment.assignmentId)); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Không tải được tiến độ'); }
  };

  if (activeJourney) {
    return <AnalysisJourneyWorkspace initialJourney={activeJourney} onChanged={setActiveJourney} onClose={() => { setActiveJourney(undefined); void refresh(); }} />;
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl p-4 sm:p-8">
      <header className="rounded-[2rem] bg-gradient-to-r from-[#5EADFF] to-[#8B7CFF] p-6 text-white shadow-xl">
        <p className="text-xs font-black uppercase tracking-widest">Teaching Mode</p>
        <h1 className="mt-1 font-heading text-3xl font-black">🎓 Jelly Trail Classroom</h1>
        <p className="mt-2 max-w-3xl font-bold text-white/90">Journey 10 bước: KPI → activation → retention → difficulty → economy → monetization → UA → LiveOps → A/B → RCA.</p>
      </header>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <form onSubmit={join} className="rounded-3xl bg-white p-5 shadow-lg">
          <h2 className="font-heading text-xl font-black text-[#315F8A]">Vào lớp bằng mã</h2>
          <label htmlFor="classroom-join-code" className="sr-only">Mã lớp</label>
          <input id="classroom-join-code" value={joinCode} onChange={event => setJoinCode(event.target.value.toUpperCase())} required placeholder="MÃ LỚP" className="mt-4 w-full rounded-xl border-2 border-blue-200 px-3 py-3 font-black uppercase" />
          <button className="mt-3 w-full rounded-xl bg-[#5EADFF] py-3 font-black text-white">Tham gia</button>
        </form>
        {canTeach && <form onSubmit={create} className="rounded-3xl bg-white p-5 shadow-lg">
          <h2 className="font-heading text-xl font-black text-[#4A7A37]">Tạo lớp giảng dạy</h2>
          <label htmlFor="classroom-name" className="sr-only">Tên lớp</label>
          <input id="classroom-name" value={name} onChange={event => setName(event.target.value)} required maxLength={80} className="mt-4 w-full rounded-xl border-2 border-green-200 px-3 py-3 font-bold" />
          <button className="mt-3 w-full rounded-xl bg-[#71B15A] py-3 font-black text-white">Tạo lớp</button>
        </form>}
      </div>

      {message && <p role="status" className="mt-4 rounded-xl bg-white p-3 text-center font-bold text-slate-700 shadow">{message}</p>}
      {loading && <p className="mt-4 text-center font-black text-slate-500">Đang đồng bộ lớp và assignment…</p>}

      <section className="mt-6">
        <h2 className="font-heading text-2xl font-black text-[#5D4632]">Lớp của tôi</h2>
        {!loading && classrooms.length === 0 && <EmptyState copy="Chưa tham gia lớp nào. Nhập mã lớp ở trên để bắt đầu." />}
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {classrooms.map(classroom => <article key={classroom.classroomId} className="min-w-0 rounded-3xl border-2 border-[#FFCF4D] bg-white p-5 shadow">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 break-words"><span className="rounded-full bg-purple-50 px-2 py-1 text-[10px] font-black uppercase text-purple-700">{classroom.membershipRole === 'teacher' ? 'Giáo viên' : 'Học viên'}</span><h3 className="mt-2 text-xl font-black">{classroom.name}</h3><p className="mt-1 text-sm font-bold text-slate-500">{classroom.studentCount} học viên</p></div><div className="rounded-2xl bg-[#FFF1CC] px-4 py-3 text-center"><span className="block text-[10px] font-black uppercase">Mã lớp</span><strong className="tracking-widest text-[#855D00]">{classroom.joinCode}</strong></div></div>
            {canTeach && classroom.membershipRole === 'teacher' && <AssignmentComposer classroomId={classroom.classroomId} scenarios={scenarios} onCreated={async title => { setMessage(`Đã giao: ${title}`); await refresh(); }} />}
          </article>)}
        </div>
      </section>

      <section className="mt-7" aria-labelledby="learner-assignments-title">
        <h2 id="learner-assignments-title" className="font-heading text-2xl font-black text-[#315F8A]">Bài phân tích của học viên</h2>
        {!loading && assignments.length === 0 && <EmptyState copy="Chưa có assignment dành cho tài khoản này." />}
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {assignments.map(assignment => <AssignmentCard key={assignment.assignmentId} assignment={assignment} onOpen={() => void openAssignment(assignment)} />)}
        </div>
      </section>

      {canTeach && <section className="mt-7" aria-labelledby="teacher-assignments-title">
        <h2 id="teacher-assignments-title" className="font-heading text-2xl font-black text-[#4A7A37]">Theo dõi assignment</h2>
        <div className="mt-3 space-y-4">{classrooms.filter(item => item.membershipRole === 'teacher').map(classroom => <article key={classroom.classroomId} className="rounded-3xl bg-white p-5 shadow"><h3 className="text-lg font-black">{classroom.name}</h3><div className="mt-3 grid gap-3 md:grid-cols-2">{(teacherAssignments[classroom.classroomId] ?? []).map(assignment => <div key={assignment.assignmentId} className="rounded-2xl bg-green-50 p-4"><p className="text-xs font-black uppercase text-green-700">{assignment.scenarioTitle}</p><strong className="mt-1 block">{assignment.title}</strong><button data-testid={`progress-${assignment.assignmentId}`} onClick={() => void openProgress(assignment)} className="mt-3 rounded-xl bg-[#71B15A] px-4 py-2 font-black text-white">Xem tiến độ</button></div>)}</div>{(teacherAssignments[classroom.classroomId] ?? []).length === 0 && <p className="mt-2 text-sm font-semibold text-slate-500">Chưa giao bài.</p>}</article>)}</div>
      </section>}

      {dashboard && <TeacherProgress dashboard={dashboard} onClose={() => setDashboard(undefined)} />}

      <section className="mt-7 pb-20"><h2 className="font-heading text-2xl font-black text-[#5D4632]">Scenario học tập</h2><div className="mt-3 grid gap-3 md:grid-cols-2">{scenarios.map(scenario => <article key={scenario.scenarioId} className="rounded-3xl bg-white p-5 shadow"><div className="flex items-center justify-between"><p className="text-[10px] font-black uppercase text-orange-600">{scenario.immutableRevision}</p><span className="text-xs font-black text-slate-500">⏱ {scenario.estimatedMinutes} phút</span></div><h3 className="mt-1 text-lg font-black">{scenario.title}</h3><p className="mt-2 text-sm font-semibold text-slate-600">{scenario.description}</p><ul className="mt-3 list-inside list-disc text-xs font-bold text-slate-500">{scenario.learningObjectives.map(item => <li key={item}>{item}</li>)}</ul><p className="mt-3 text-xs font-black text-blue-700">{scenario.journeySteps.length} bước phân tích</p></article>)}</div></section>
    </main>
  );
}

function AssignmentComposer({ classroomId, scenarios, onCreated }: { classroomId: string; scenarios: ScenarioPack[]; onCreated: (title: string) => Promise<void> }) {
  const [scenarioId, setScenarioId] = useState(scenarios[0]?.scenarioId ?? '');
  const [working, setWorking] = useState(false);
  useEffect(() => { if (!scenarioId && scenarios[0]) setScenarioId(scenarios[0].scenarioId); }, [scenarioId, scenarios]);
  const assign = async () => {
    const scenario = scenarios.find(item => item.scenarioId === scenarioId);
    if (!scenario) return;
    setWorking(true);
    try {
      const opensAt = new Date(Date.now() - 60_000).toISOString();
      const closesAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
      await classroomApi.assign(classroomId, { scenarioId, title: scenario.title, opensAt, closesAt });
      await onCreated(scenario.title);
    } finally { setWorking(false); }
  };
  return <div className="mt-4 border-t pt-4"><label className="text-xs font-black uppercase text-slate-500" htmlFor={`scenario-${classroomId}`}>Scenario để giao</label><select id={`scenario-${classroomId}`} value={scenarioId} onChange={event => setScenarioId(event.target.value)} className="mt-2 w-full rounded-xl border-2 border-purple-100 p-3 font-bold">{scenarios.map(item => <option key={item.scenarioId} value={item.scenarioId}>{item.title}</option>)}</select><button data-testid={`assign-${classroomId}`} onClick={() => void assign()} disabled={!scenarioId || working} className="mt-3 w-full rounded-xl bg-[#8B7CFF] py-3 font-black text-white disabled:opacity-50">{working ? 'Đang giao…' : 'Giao journey trong 7 ngày'}</button></div>;
}

function AssignmentCard({ assignment, onOpen }: { key?: string; assignment: TeachingAssignmentSummary; onOpen: () => void }) {
  const copy = assignment.attemptStatus === 'submitted' ? `Đã nộp · ${assignment.attemptScore ?? 0}/100` : assignment.attemptStatus === 'draft' ? 'Đang làm · tiếp tục' : assignment.availability === 'open' ? 'Bắt đầu journey' : assignment.availability === 'upcoming' ? 'Chưa mở' : 'Đã đóng';
  const disabled = assignment.attemptStatus === 'not_started' && assignment.availability !== 'open';
  return <article data-testid={`assignment-${assignment.assignmentId}`} className="rounded-3xl bg-white p-5 shadow"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black uppercase text-purple-600">{assignment.classroomName}</p><h3 className="mt-1 text-xl font-black text-[#23395B]">{assignment.title}</h3><p className="mt-2 text-sm font-semibold text-slate-600">{assignment.scenarioTitle}</p></div><StatusPill status={assignment.attemptStatus} /></div><p className="mt-3 text-xs font-bold text-slate-500">Hạn {new Date(assignment.closesAt).toLocaleString('vi-VN')}</p><button onClick={onOpen} disabled={disabled} className="mt-4 w-full rounded-xl bg-[#5EADFF] py-3 font-black text-white disabled:bg-slate-200 disabled:text-slate-500">{copy}</button></article>;
}

function TeacherProgress({ dashboard, onClose }: { dashboard: TeacherAssignmentDashboard; onClose: () => void }) {
  return <section data-testid="teacher-progress" className="mt-6 rounded-[2rem] border-4 border-green-200 bg-white p-5 shadow-xl"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black uppercase text-green-700">Teacher dashboard</p><h2 className="text-2xl font-black">{dashboard.assignment.title}</h2><p className="text-sm font-semibold text-slate-500">{dashboard.scenarioTitle}</p></div><button onClick={onClose} className="rounded-xl bg-slate-100 px-3 py-2 font-black">Đóng</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2"><Metric label="Hoàn thành" value={`${(dashboard.completionRate * 100).toFixed(0)}%`} /><Metric label="Điểm trung bình" value={dashboard.averageScore === undefined ? '—' : dashboard.averageScore.toFixed(1)} /></div><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead><tr className="text-slate-500"><th className="p-2">Học viên</th><th>Trạng thái</th><th>Tiến độ</th><th>Điểm</th></tr></thead><tbody>{dashboard.learners.map(learner => <tr key={learner.accountId} className="border-t"><td className="p-2 font-bold">{learner.displayName}</td><td>{learner.status}</td><td>{Math.min(learner.currentStep + (learner.status === 'submitted' ? 1 : 0), learner.totalSteps)}/{learner.totalSteps}</td><td>{learner.score ?? '—'}</td></tr>)}</tbody></table>{dashboard.learners.length === 0 && <p className="p-4 text-center font-semibold text-slate-500">Chưa có học viên trong lớp.</p>}</div></section>;
}

function StatusPill({ status }: { status: TeachingAssignmentSummary['attemptStatus'] }) {
  const config = { not_started: ['Chưa làm', 'bg-slate-100 text-slate-600'], draft: ['Đang làm', 'bg-amber-100 text-amber-700'], submitted: ['Đã nộp', 'bg-green-100 text-green-700'] }[status];
  return <span className={`rounded-full px-3 py-1 text-xs font-black ${config[1]}`}>{config[0]}</span>;
}

function EmptyState({ copy }: { copy: string }) { return <p className="mt-3 rounded-2xl border-2 border-dashed border-slate-200 p-5 text-center font-semibold text-slate-500">{copy}</p>; }
function Metric({ label, value }: { label: string; value: string }) { return <article className="rounded-2xl bg-green-50 p-4"><p className="text-xs font-black uppercase text-green-700">{label}</p><strong className="mt-1 block text-3xl text-[#315F8A]">{value}</strong></article>; }
