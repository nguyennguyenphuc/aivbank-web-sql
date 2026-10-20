import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** Khung so lieu hep hon muc nay thi bang so va log khong con doc duoc. */
export const LOG_MIN = 320;
/** Chua lai cho vung choi it nhat chung nay - duoi do ban keo khong dung duoc. */
export const GAME_MIN = 420;
/** Trung voi `@media(min-width:1100px)` trong game-learning.css. */
export const SIDE_PANEL_MIN_VIEWPORT = 1100;

const STORAGE_KEY = 'jelly-log-width';
const STEP = 12;
const STEP_FAST = 48;

/** Ep `px` vao [LOG_MIN, viewport - GAME_MIN]. Cua so qua hep thi san thang. */
export function clampLogWidth(px: number, viewport: number): number {
  const max = Math.max(LOG_MIN, viewport - GAME_MIN);
  if (!Number.isFinite(px)) return LOG_MIN;
  return Math.round(Math.min(Math.max(px, LOG_MIN), max));
}

function readSaved(): number | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeSaved(px: number | null): void {
  try {
    if (px === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, String(px));
  } catch {
    /* Che do rieng tu: keo van chay, chi la khong nho. */
  }
}

function apply(px: number | null): void {
  const root = document.documentElement.style;
  if (px === null) root.removeProperty('--log-w');
  else root.setProperty('--log-w', `${px}px`);
}

/**
 * Be rong khung so lieu, keo duoc. `null` = mac dinh cua CSS (min(42vw,500px)).
 * Luu trong `sessionStorage` chu khong phai `localStorage`: may phong lab dung
 * chung, tab dong la quen.
 */
export function useLogWidth() {
  const [width, setWidth] = useState<number | null>(() => readSaved());
  const dragging = useRef(false);

  useEffect(() => {
    const fit = () => {
      if (width === null) return apply(null);
      const next = clampLogWidth(width, window.innerWidth);
      apply(next);
      if (next !== width) setWidth(next);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [width]);

  const commit = useCallback((px: number) => {
    const next = clampLogWidth(px, window.innerWidth);
    setWidth(next);
    writeSaved(next);
  }, []);

  /** Be rong dang hien thi, ke ca khi van la mac dinh cua CSS. */
  const current = () => {
    const host = document.getElementById('global-event-log');
    return host ? host.getBoundingClientRect().width : LOG_MIN;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const bar = event.currentTarget;
    bar.setPointerCapture(event.pointerId);
    bar.classList.add('is-dragging');
    document.body.classList.add('is-resizing-log');
    dragging.current = true;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    // Khung nam ben PHAI: be rong la khoang tu con tro toi mep phai cua so.
    commit(window.innerWidth - event.clientX);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing-log');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? STEP_FAST : STEP;
    let next: number;
    // Mui ten TRAI keo vach sang trai, tuc khung so lieu RONG ra.
    if (event.key === 'ArrowLeft') next = current() + step;
    else if (event.key === 'ArrowRight') next = current() - step;
    else if (event.key === 'Home') next = LOG_MIN;
    else if (event.key === 'End') next = window.innerWidth - GAME_MIN;
    else return;
    event.preventDefault();
    commit(next);
  };
  /** Nhan dup = ve mac dinh. Loi thoat khi lo tay keo qua da. */
  const onDoubleClick = () => {
    setWidth(null);
    writeSaved(null);
  };

  return {
    width,
    max: Math.max(LOG_MIN, (typeof window === 'undefined' ? SIDE_PANEL_MIN_VIEWPORT : window.innerWidth) - GAME_MIN),
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown, onDoubleClick },
  };
}
