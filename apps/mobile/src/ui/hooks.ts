import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';

/** Suscripción reactiva a consultas de Dexie: se actualiza sola al cambiar los datos. */
export function useLive<T>(query: () => Promise<T>, deps: readonly unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setValue, error: (e) => console.error('liveQuery', e) });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** Instante actual, refrescado cada `intervalMs`. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    const onVisible = () => setNow(Date.now());
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  return now;
}

export type ThemePref = 'auto' | 'light' | 'dark' | 'night';

export function applyTheme(pref: ThemePref): void {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const theme = pref === 'auto' ? (dark ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = theme;
  const color = { light: '#f7f0e6', dark: '#181226', night: '#050304' }[theme];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem('bs-theme');
    return v === 'light' || v === 'dark' || v === 'night' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem('bs-theme', pref);
  } catch {
    /* sin almacenamiento: el tema solo dura esta sesión */
  }
  applyTheme(pref);
}
