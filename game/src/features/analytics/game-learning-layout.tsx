import { useState, type FC, type ReactNode } from 'react';
import { Activity, ArrowUpRight, BookOpen, Braces, Check, Download, Maximize2, Minimize2, Pause, Play, Sparkles } from 'lucide-react';
import { EVENT_LIMIT, eventLessons, type GameMode, type ObservationState, type ObservedEvent } from './game-observations';
import './game-learning.css';

import { GameAttemptScope, useObservationStudio } from './game-observation-context';
import { usePlayOnly } from './play-only';

export const GameLearningLayout: FC<{
  children: ReactNode; levelId: number; mode: GameMode; language: 'vi' | 'en'; onReplay: () => void; onInspect: () => void;
}> = ({ children, levelId, mode, language, onReplay, onInspect }) => {
  const { state } = useObservationStudio();
  const vi = language === 'vi';
  const [playOnly, togglePlayOnly] = usePlayOnly();
  const [showGuide, setShowGuide] = useState(() => {
    try { return sessionStorage.getItem('jelly-studio-guide-seen') !== '1'; } catch { return true; }
  });
  const dismissGuide = () => {
    setShowGuide(false);
    try { sessionStorage.setItem('jelly-studio-guide-seen', '1'); } catch { /* Guidance remains usable without storage. */ }
  };
  const jumpToGame = () => {
    const game = document.getElementById('live-game-area');
    game?.focus({ preventScroll: true });
    game?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const ended = (mode === 'practice' && state.status === 'completed') || ['verified', 'rejected', 'error'].includes(state.status);
  return (
    <GameAttemptScope levelId={levelId} mode={mode}>
      <div className="learning-studio">
        <header className="studio-heading">
          <div className="studio-brand"><span className="studio-brand-icon"><Sparkles size={23} /></span><div><span className="studio-eyebrow">JELLY TRAIL ACADEMY</span><h1>{vi ? 'Kéo kẹo trước. Đọc dữ liệu sau.' : 'Drag first. Read data next.'}</h1></div></div>
          <span className="studio-mode"><span />{vi ? `Màn ${levelId}` : `Level ${levelId}`}</span>
          <button className="studio-help" aria-pressed={playOnly} aria-keyshortcuts="Alt+P" onClick={togglePlayOnly}
            title={vi ? 'Ẩn khung số liệu, phóng to bàn chơi (Alt+P)' : 'Hide the data panel, enlarge the board (Alt+P)'}>
            {playOnly ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            {playOnly ? (vi ? 'Hiện số liệu' : 'Show data') : (vi ? 'Chỉ chơi' : 'Play only')}
          </button>
          <button className="studio-help" aria-expanded={showGuide} aria-controls="studio-first-steps" onClick={() => showGuide ? dismissGuide() : setShowGuide(true)}><BookOpen size={16} />{vi ? 'Dạy học' : 'Lesson'}</button>
        </header>
        <nav className="studio-mobile-jump" aria-label={vi ? 'Chuyển giữa game và dữ liệu' : 'Jump between game and data'}>
          <button onClick={jumpToGame} aria-controls="live-game-area"><Play size={17} />{vi ? 'Chơi' : 'Play'}</button>
          <button onClick={onInspect} aria-controls="live-learning-panel"><Activity size={17} />{vi ? 'Xem dữ liệu' : 'View data'}<span>{state.count}</span></button>
        </nav>
        <section id="studio-first-steps" className="studio-first-steps" hidden={!showGuide} aria-label={vi ? 'Ba bước làm quen' : 'Three quick steps'}>
          <div className="studio-guide-heading"><strong>{vi ? 'Thứ tự nhìn' : 'Where to look'}</strong><button onClick={dismissGuide}>{vi ? 'Ẩn' : 'Hide'}</button></div>
          <ol>
            <li><span>{state.accepted ? <Check size={15} /> : '1'}</span>{vi ? 'Nhìn bàn ở giữa.' : 'Look at the centered board.'}</li>
            <li><span>2</span>{vi ? 'Kéo một viên sang ô cạnh bên.' : 'Drag one candy into a neighbor.'}</li>
            <li><span>3</span>{vi ? 'Sau nước đi, mở log để học dữ liệu.' : 'After a move, open the log to learn data.'}</li>
          </ol>
        </section>
        <div className="studio-columns">
          <section id="live-game-area" tabIndex={-1} className="studio-game" aria-label={vi ? 'Khu vực chơi game' : 'Game area'}>
            <div className="studio-section-label"><span>{vi ? 'CHƠI' : 'PLAY'}</span><span>{vi ? 'Ít chữ trong vùng game' : 'Game zone stays quiet'}</span></div>
            {children}
            {ended && <div className="studio-result-actions"><button onClick={onInspect}><BookOpen size={16} />{vi ? 'Đọc dữ liệu lượt này' : 'Inspect this attempt'}</button><button onClick={onReplay}>{vi ? 'Chơi lại' : 'Replay'}<ArrowUpRight size={16} /></button></div>}
          </section>
        </div>
        <p className="studio-footnote">{vi ? 'Dữ liệu nằm trong bảng dạy học, không chen vào vùng chơi.' : 'Data stays in the lesson panel, not inside the play zone.'}</p>
      </div>
    </GameAttemptScope>
  );
}

export function LearningPanel({ state, vi }: { state: ObservationState; vi: boolean }) {
  const { sync, retrySync } = useObservationStudio();
  const syncProblems = vi
    ? { offline: 'Ngoại tuyến; giữ hàng đợi trên thiết bị.', retrying: 'Chưa gửi được; đang thử lại.', rejected: 'Máy chủ từ chối; dữ liệu vẫn chờ. Đăng nhập đúng tài khoản rồi thử lại.', storage: 'Không truy cập được bộ nhớ trình duyệt.', full: 'Hàng đợi đầy.', corrupt: 'Bản ghi lưu trên thiết bị không hợp lệ; chưa gửi.' }
    : { offline: 'Offline; queue kept on this device.', retrying: 'Delivery unconfirmed; retrying.', rejected: 'Server rejected delivery; records kept. Sign in to the matching account and retry.', storage: 'Browser storage unavailable.', full: 'Outbox full.', corrupt: 'Saved observation is invalid; not sent.' };
  const mode = state.currentAttempt?.mode;
  const [frozen, setFrozen] = useState<ObservedEvent[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<ObservedEvent | null>(null);
  const [view, setView] = useState<'events' | 'lesson'>('events');
  const events = frozen ?? state.events;
  const visible = events.filter(event => filter === 'all' || (filter === 'moves' ? event.type.startsWith('move_') : !event.type.startsWith('move_')));
  const inspected = selected ?? events.at(-1);
  const attempts = state.accepted + state.rejected;
  const rate = attempts ? `${Math.round(state.accepted / attempts * 100)}%` : '—';
  const average = state.accepted ? Math.round(state.movePoints / state.accepted).toLocaleString() : '—';
  const statuses = vi
    ? { waiting: 'Chờ bàn chơi', playing: 'Đang quan sát', completed: 'Kết thúc cục bộ', verifying: 'Đang xác nhận', verified: 'Đã xác nhận', rejected: 'Máy chủ từ chối', error: 'Chưa xác nhận' }
    : { waiting: 'Waiting', playing: 'Observing', completed: 'Client outcome', verifying: 'Verifying', verified: 'Verified', rejected: 'Server rejected', error: 'Unconfirmed' };
  const download = () => {
    const payload = { schema: 'jelly.app-observations.v2', source: 'browser', totalEvents: state.count, retainedEvents: state.events.length, truncated: state.count > EVENT_LIMIT, latestAttempt: state.currentAttempt, latestAttemptSummary: { accepted: state.accepted, rejected: state.rejected, movePoints: state.movePoints, score: state.score, status: state.status }, events: state.events };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'jelly-app-observations.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <aside id="live-learning-panel" tabIndex={-1} className="learning-panel" aria-label={vi ? 'Phòng phân tích dữ liệu trực tiếp' : 'Live data learning lab'}>
      <div className="studio-section-label"><span>EVENT LOG / {vi ? 'TOÀN APP' : 'APP-WIDE'}</span><Activity size={15} /></div>
      <div className="lab-heading"><div><h2>{vi ? 'Điều gì vừa xảy ra?' : 'What just happened?'}</h2><p>{vi ? 'Lịch sử phiên này, xuyên suốt mọi màn hình.' : 'This session’s history, across every screen.'}</p></div><span className="lab-status" role="status">{state.currentAttempt ? statuses[state.status] : (vi ? 'Chưa có lượt chơi' : 'No attempt yet')}</span></div>
      <p className="lab-attempt-scope">{state.currentAttempt ? `${vi ? 'Chỉ số lượt gần nhất' : 'Latest attempt metrics'} · ${mode} · ${vi ? 'Màn' : 'Level'} ${state.currentAttempt.levelId}` : (vi ? 'Chơi một màn để xem chỉ số. Log chuyển màn vẫn được ghi bên dưới.' : 'Play a level to see metrics. Screen transitions are logged below.')}</p>
      <div className="lab-retention" role="status" aria-live="polite">
        <p>{vi ? 'Lưu lượt chơi' : 'Gameplay sync'}: {sync.pending > 0
          ? `${sync.pending} ${vi ? 'sự kiện đang chờ' : 'events pending'}`
          : sync.problem || sync.loss ? (vi ? 'Đồng bộ cần chú ý' : 'Sync needs attention')
          : sync.signedIn ? (vi ? 'Đã đồng bộ hàng đợi' : 'Queue synced') : (vi ? 'Đăng nhập để đồng bộ' : 'Sign in to sync')}.
          {!sync.signedIn && sync.pending > 0 && (vi ? ' Đăng nhập lại tài khoản gốc để gửi.' : ' Sign in to the original account to deliver.')}
          {sync.problem && ` ${syncProblems[sync.problem]}`}</p>
        {sync.loss && <p role="alert">{vi ? 'Một số sự kiện không được lưu vì hàng đợi đầy hoặc lỗi bộ nhớ. Lịch sử đồng bộ không đầy đủ.' : 'Some observations were not saved because storage failed or the outbox filled. Synced history is incomplete.'}</p>}
        {sync.signedIn && (sync.problem || sync.pending > 0) && <button type="button" className="font-bold underline" onClick={retrySync}>{vi ? 'Thử đồng bộ lại' : 'Retry sync'}</button>}
      </div>
      <div className="lab-metrics">
        <Metric value={`${state.accepted}/${attempts}`} label={vi ? 'Đổi kẹo hợp lệ' : 'Valid swaps'} detail={vi ? `${rate} lần thử` : `${rate} of attempts`} />
        <Metric value={average} label={vi ? 'Điểm / nước đi' : 'Points / move'} detail={vi ? 'Không gồm thưởng & vật phẩm' : 'Excludes bonuses & boosters'} />
        <Metric value={state.cascades.toString()} label={vi ? 'Đợt xử lý' : 'Resolution waves'} detail={vi ? 'Từ nước đổi kẹo hợp lệ' : 'From accepted swaps'} />
      </div>
      <ScoreTrend state={state} vi={vi} />
      <div className="lab-tabs" role="group" aria-label={vi ? 'Nội dung phân tích' : 'Analysis view'}>
        <button aria-pressed={view === 'events'} onClick={() => setView('events')}><Braces size={15} />{vi ? 'Sự kiện trực tiếp' : 'Live events'}<span>{state.count}</span></button>
        <button aria-pressed={view === 'lesson'} onClick={() => setView('lesson')}><BookOpen size={15} />{vi ? 'Cách phân tích' : 'How to analyze'}</button>
      </div>
      {view === 'events' ? <>
        <div className="lab-tools">
          <select aria-label={vi ? 'Lọc sự kiện' : 'Filter events'} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{vi ? 'Tất cả sự kiện' : 'All events'}</option><option value="moves">{vi ? 'Nước đi' : 'Moves'}</option><option value="system">{vi ? 'Màn & hệ thống' : 'Level & system'}</option></select>
          <button onClick={() => setFrozen(frozen ? null : [...state.events])} aria-pressed={Boolean(frozen)} title={vi ? 'Chỉ dừng hiển thị log; game và thống kê vẫn chạy' : 'Freeze log display only; game and metrics continue'}>{frozen ? <Play size={14} /> : <Pause size={14} />}{frozen ? (vi ? 'Tiếp tục' : 'Resume') : (vi ? 'Dừng cuộn' : 'Freeze')}</button>
          <button onClick={download} aria-label={vi ? 'Tải dữ liệu JSON' : 'Download JSON'} title="JSON"><Download size={15} /></button>
        </div>
        {frozen && <p className="lab-paused">{vi ? 'Đang giữ nguyên danh sách. Game, thống kê và bản tải JSON vẫn cập nhật.' : 'List frozen. Game, metrics and JSON export continue updating.'}</p>}
        <div className="event-feed" tabIndex={0} aria-label={vi ? 'Danh sách sự kiện, mới nhất trước' : 'Events, newest first'}>
          {!visible.length && <p className="lab-empty">{vi ? 'Chưa có sự kiện phù hợp. Hãy đổi hai viên kẹo cạnh nhau để bắt đầu quan sát.' : 'No matching events. Swap two neighboring candies to begin.'}</p>}
          {visible.slice().reverse().map(event => <button key={event.sequence} className={`event-row ${inspected?.sequence === event.sequence ? 'is-selected' : ''}`} aria-pressed={inspected?.sequence === event.sequence} onClick={() => setSelected(event)}>
            <span className={`event-dot ${event.type.includes('rejected') || event.type.includes('failed') ? 'is-warning' : ''}`} />
            <span className="event-copy"><strong>{vi ? eventLessons[event.type].vi : eventLessons[event.type].en}</strong><code>{event.type}</code><small className="event-scope">{event.attempt ? `${event.attempt.mode} · ${vi ? 'Màn' : 'Level'} ${event.attempt.levelId} · ${event.attempt.id.slice(0, 8)}` : event.type === 'screen_viewed' ? event.screen : event.type === 'dialog_opened' ? event.dialog : ''}</small></span>
            <span className="event-meta"><span>+{(event.elapsedMs / 1000).toFixed(1)}s</span><span>{event.type === 'move_resolved' ? `+${event.delta}` : `#${event.sequence}`}</span></span>
          </button>)}
        </div>
        <p className="lab-retention">{vi ? `Giữ ${EVENT_LIMIT} sự kiện gần nhất toàn app · Đổi màn không xoá log · Tải lại trang bắt đầu phiên mới` : `Last ${EVENT_LIMIT} app events · Survives navigation · Reload starts a new session`}</p>
        {inspected && <div className="event-inspector"><div className="inspector-label"><span>{vi ? 'ĐỌC MỘT SỰ KIỆN' : 'READ AN EVENT'} #{inspected.sequence}</span>{selected && <button onClick={() => setSelected(null)}>{vi ? 'Theo mới nhất' : 'Follow latest'}</button>}</div><p>{vi ? eventLessons[inspected.type].lesson : eventLessons[inspected.type].lessonEn}</p><details><summary>{vi ? 'Xem các trường dữ liệu' : 'Inspect event fields'}</summary><pre>{JSON.stringify(inspected, null, 2)}</pre></details></div>}
      </> : <div className="lab-lesson">
        <h3>{vi ? 'Bắt đầu từ một câu hỏi nhỏ' : 'Start with a small question'}</h3>
        <p>{vi ? '“Các lần đổi kẹo không hợp lệ có nhiều không?” Chơi thử vài nước, rồi mở bộ lọc Nước đi và so số lần hợp lệ với toàn bộ lần thử.' : '“How often are swaps rejected?” Try several moves, then filter Moves and compare accepted swaps with all attempts.'}</p>
        <code>{state.accepted} / ({state.accepted} + {state.rejected}) = {rate}</code>
        <h3>{vi ? 'Kiểm tra mẫu số trước khi kết luận' : 'Check the denominator first'}</h3>
        <p>{vi ? 'Điểm mỗi nước = tổng delta của move_resolved / số nước hợp lệ. Điểm thưởng cuối màn và điểm từ vật phẩm không nằm trong tử số này.' : 'Points per move = sum of move_resolved deltas / accepted swaps. End bonuses and booster points are excluded.'}</p>
        <code>{state.movePoints} / {state.accepted || '—'} = {average}</code>
        <h3>{vi ? 'Một lượt chơi chưa phải toàn bộ game' : 'One attempt is not the whole game'}</h3>
        <p>{vi ? 'Đây là lịch sử của một phiên trình duyệt, không phải kho dữ liệu toàn game. Chỉ số phía trên chỉ tính lượt gần nhất, không cộng lẫn các màn. Chưa thể suy ra DAU, retention, doanh thu hoặc quan hệ nhân quả.' : 'This is one browser session, not the game warehouse. Metrics above cover the latest attempt only, never a mixture of levels. They cannot establish DAU, retention, revenue or causality.'}</p>
        <div className="lesson-source"><Check size={17} /><p>{mode === 'ranked' ? (vi ? 'Ranked: verification_completed mô tả phản hồi máy chủ. Bản ghi đồng bộ vẫn là quan sát client, không phải nguồn điểm có thẩm quyền.' : 'Ranked: verification_completed describes a server response. Synced observations are still client-reported, not authoritative scores.') : (vi ? 'Luyện tập: quan sát cục bộ được xếp hàng đồng bộ, không dùng cho bảng xếp hạng.' : 'Practice: local observations are queued for sync, not ranked results.')}</p></div>
      </div>}
    </aside>
  );
}

function Metric({ value, label, detail }: { value: string; label: string; detail: string }) {
  return <div className="lab-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
function ScoreTrend({ state, vi }: { state: ObservationState; vi: boolean }) {
  const values = state.trend;
  const max = Math.max(1, ...values.map(point => point.score));
  const points = values.map((point, i) => `${8 + i * 284 / Math.max(1, values.length - 1)},${62 - point.score / max * 48}`).join(' ');
  return <figure className="score-trend"><figcaption><span>{vi ? 'ĐIỂM HIỆN TẠI' : 'CURRENT SCORE'}</span><b>{state.score.toLocaleString()}</b></figcaption><p className="lab-retention">{vi ? 'Đường biểu diễn: điểm sau mỗi nước đổi kẹo hợp lệ, chưa gồm thưởng cuối màn.' : 'Line: score after each accepted swap, before end bonuses.'}</p>
    {values.length ? <><svg viewBox="0 0 300 76" role="img" aria-label={vi ? 'Diễn biến điểm; bảng số liệu bên dưới' : 'Score progression; data table below'}><path d="M8 62H292M8 38H292M8 14H292" stroke="#e1e8ef" strokeDasharray="3 4" /><polyline points={points} fill="none" stroke="#087f8c" strokeWidth="2.5" strokeLinejoin="round" />{values.map((point, i) => <circle key={point.move} cx={8 + i * 284 / Math.max(1, values.length - 1)} cy={62 - point.score / max * 48} r="3" fill="#087f8c" />)}</svg><details><summary>{vi ? 'Bảng điểm · tối đa 30 nước gần nhất' : 'Score table · last 30 moves'}</summary><table><thead><tr><th>{vi ? 'Nước' : 'Move'}</th><th>{vi ? 'Điểm' : 'Score'}</th></tr></thead><tbody>{values.map(point => <tr key={point.move}><td>{point.move}</td><td>{point.score}</td></tr>)}</tbody></table></details></> : <p>{vi ? 'Biểu đồ sẽ xuất hiện sau nước đi hợp lệ đầu tiên.' : 'Your first valid move will start the chart.'}</p>}
  </figure>;
}
