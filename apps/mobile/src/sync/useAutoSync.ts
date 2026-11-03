import { toIso } from '@babysleep/core';
import { liveQuery } from 'dexie';
import { useEffect } from 'react';
import type { Ctx } from '../domain/context';
import { currentSession } from './auth';
import { syncOnce } from './engine';
import { getSupabaseClient, supabaseTransport } from './supabase';

/** Resultado de la última pasada, para mostrarlo en Ajustes. */
export interface SyncStatus {
  at: string;
  ok: boolean;
  error: string | null;
  rejected: number;
  conflicts: number;
  sessionExpired: boolean;
}

const INTERVAL_MS = 60_000;
const AFTER_WRITE_MS = 3_000;

/**
 * Sincroniza sola mientras la app está abierta: al abrirla, al volver a primer plano, al recuperar la red,
 * cada minuto y unos segundos después de registrar algo. Solo actúa si el móvil está conectado; si no, no
 * descarga ni ejecuta nada de la sincronización. (iOS no permite sincronizar en segundo plano con la app cerrada.)
 */
export function useAutoSync(ctx: Ctx): void {
  useEffect(() => {
    if (!ctx.db.syncEnabled) return;
    let stopped = false;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const save = (s: SyncStatus) => ctx.db.meta.put({ key: 'sync_status', value: s });

    const run = async (): Promise<void> => {
      if (stopped) return;
      if (running) {
        again = true; // se pidió otra mientras iba una: se repite al terminar
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      running = true;
      try {
        const client = await getSupabaseClient();
        if ((await currentSession(client)) === null) {
          await save({ at: toIso(ctx.now()), ok: false, error: null, rejected: 0, conflicts: 0, sessionExpired: true });
          return;
        }
        const report = await syncOnce(ctx, supabaseTransport(client));
        await save({
          at: toIso(ctx.now()), ok: report.ok, error: report.error ?? null,
          rejected: report.rejected, conflicts: report.conflicts.length, sessionExpired: false,
        });
      } catch (e) {
        await save({ at: toIso(ctx.now()), ok: false, error: e instanceof Error ? e.message : String(e), rejected: 0, conflicts: 0, sessionExpired: false });
      } finally {
        running = false;
        if (again && !stopped) {
          again = false;
          setTimeout(() => void run(), 1000);
        }
      }
    };

    void run();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void run();
    };
    const onOnline = () => void run();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const interval = setInterval(() => void run(), INTERVAL_MS);
    const sub = liveQuery(() => ctx.db.outbox.count()).subscribe({
      next: (n) => {
        if (n === 0) return;
        clearTimeout(timer);
        timer = setTimeout(() => void run(), AFTER_WRITE_MS);
      },
      error: () => undefined,
    });

    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      sub.unsubscribe();
    };
  }, [ctx]);
}
