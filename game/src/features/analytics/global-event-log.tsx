import { useEffect } from 'react';
import { Activity, X } from 'lucide-react';
import { useAccessibleDialog } from '../../components/modals/HowToPlayModal';
import { LearningPanel } from './game-learning-layout';
import { useObservationStudio } from './game-observation-context';
import { useAuth } from '../auth/auth-context';
import { LOG_MIN, useLogWidth } from './log-width';

export function GlobalEventLog() {
  const { state, open, setOpen, language } = useObservationStudio();
  const { principal } = useAuth();
  const vi = language === 'vi';
  const dialogRef = useAccessibleDialog(() => setOpen(false), 'close-global-event-log', open);
  const logWidth = useLogWidth();
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        setOpen(previous => !previous);
      }
    };
    document.addEventListener('keydown', onShortcut);
    return () => document.removeEventListener('keydown', onShortcut);
  }, [setOpen]);
  return <>
    <button className={`global-log-launcher ${principal ? 'is-docked' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-controls="global-event-log" aria-keyshortcuts="Alt+L" onClick={() => setOpen(previous => !previous)}>
      <Activity size={18} /><span className="global-log-name">Event log</span><span className="global-log-count">{state.count}</span><small>Alt+L</small>
    </button>
    {open && <div className="global-log-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}
    <div ref={dialogRef} id="global-event-log" className={`global-log-host learning-studio ${open ? 'is-open' : ''}`} role={open ? 'dialog' : undefined} aria-modal={open ? true : undefined} aria-label={vi ? 'Event log toàn ứng dụng' : 'Application event log'}>
      <div className="global-log-controls"><span>{vi ? 'Game và đồng hồ vẫn chạy' : 'Game and timers keep running'}</span><button id="close-global-event-log" onClick={() => setOpen(false)}><X size={18} />{vi ? 'Quay lại' : 'Back'}</button></div>
      <LearningPanel state={state} vi={vi} />
    </div>
    {/* Phai dung SAU #global-event-log: CSS an thanh nay bang `.is-open ~` khi
        khung dang la hop thoai. */}
    <div
      className="global-log-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-controls="global-event-log"
      aria-valuemin={LOG_MIN}
      aria-valuemax={logWidth.max}
      aria-valuenow={logWidth.width ?? undefined}
      aria-label={vi
        ? 'Kéo để đổi bề rộng khung số liệu — mũi tên trái/phải, nhấn đúp để về mặc định'
        : 'Drag to resize the data panel — Left/Right arrows, double-click to reset'}
      tabIndex={0}
      {...logWidth.handlers}
    />
  </>;
}
