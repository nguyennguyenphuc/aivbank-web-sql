import { useCallback, useEffect, useState } from 'react';

/** Class tren <html>; game-learning.css lam phan con lai. */
export const PLAY_ONLY_CLASS = 'jelly-play-only';
const STORAGE_KEY = 'jelly-play-only';

function readSaved(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSaved(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(STORAGE_KEY, '1');
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Che do rieng tu: van bat/tat duoc, chi la khong nho. */
  }
}

/**
 * Che do "Chi choi": an khung Event log, bo tran kich thuoc cua ban choi.
 *
 * Chi dung trong man choi (GameLearningLayout). Class duoc GO khi unmount, nen
 * ve ban do the gioi thi khung so lieu hien lai binh thuong; lua chon van nho
 * trong `sessionStorage` cho lan vao man sau.
 */
export function usePlayOnly(): [boolean, () => void] {
  const [on, setOn] = useState(readSaved);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(PLAY_ONLY_CLASS, on);
    return () => root.classList.remove(PLAY_ONLY_CLASS);
  }, [on]);

  const toggle = useCallback(() => {
    setOn((previous) => {
      writeSaved(!previous);
      return !previous;
    });
  }, []);

  // Alt+P, cung kieu Alt+L cua Event log.
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        toggle();
      }
    };
    document.addEventListener('keydown', onShortcut);
    return () => document.removeEventListener('keydown', onShortcut);
  }, [toggle]);

  return [on, toggle];
}
