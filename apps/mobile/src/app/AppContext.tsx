import type { BabyT } from '@babysleep/contract';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BabySleepDb } from '../db/schema';
import { ensureBootstrap, getActiveBabyId, listBabies, setActiveBabyId } from '../domain/bootstrap';
import type { Ctx } from '../domain/context';
import { DomainError } from '../domain/context';
import { t } from '../i18n/es';
import { useAutoSync } from '../sync/useAutoSync';
import { useLive } from '../ui/hooks';

interface ToastState {
  msg: string;
  action?: { label: string; run: () => void | Promise<void> };
}

interface AppState {
  ctx: Ctx;
  babies: BabyT[];
  baby: BabyT | null;
  selectBaby: (id: string) => void;
  /** Sustituye el contexto (p. ej. al conectar la sincronización, que cambia la familia y el cuidador locales). */
  replaceCtx: (ctx: Ctx) => void;
  toast: (msg: string, action?: ToastState['action']) => void;
  /** Ejecuta una acción de dominio mostrando los errores como aviso, sin romper la pantalla. */
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}

const Ctx_ = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx_);
  if (v === null) throw new Error('useApp fuera de AppProvider');
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const db = new BabySleepDb();
    ensureBootstrap(db)
      .then(setCtx)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    // Pide almacenamiento persistente para reducir el riesgo de que el navegador lo purgue.
    void navigator.storage?.persist?.().catch(() => undefined);
  }, []);

  if (error !== null) {
    return (
      <p role="alert" className="p-6 text-danger">
        {t('common.error', { msg: error })}
      </p>
    );
  }
  if (ctx === null) return <p className="p-6 text-muted">{t('common.loading')}</p>;
  return (
    <Ready ctx={ctx} replaceCtx={setCtx}>
      {children}
    </Ready>
  );
}

function Ready({ ctx, replaceCtx, children }: { ctx: Ctx; replaceCtx: (ctx: Ctx) => void; children: ReactNode }) {
  useAutoSync(ctx);
  const babies = useLive(() => listBabies(ctx), [ctx], [] as BabyT[]);
  const activeId = useLive(() => getActiveBabyId(ctx), [ctx, babies.length], null as string | null);
  const [toastState, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback((msg: string, action?: ToastState['action']) => {
    setToast(action === undefined ? { msg } : { msg, action });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 7000);
  }, []);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        const msg = e instanceof DomainError || e instanceof Error ? e.message : String(e);
        toast(t('common.error', { msg }));
        return undefined;
      }
    },
    [toast],
  );

  const value = useMemo<AppState>(
    () => ({
      ctx,
      babies,
      baby: babies.find((b) => b.id === activeId) ?? null,
      selectBaby: (id) => void setActiveBabyId(ctx, id),
      replaceCtx,
      toast,
      run,
    }),
    [ctx, babies, activeId, toast, run, replaceCtx],
  );

  return (
    <Ctx_.Provider value={value}>
      {children}
      {toastState !== null && (
        <div
          role="status"
          className="fixed inset-x-3 bottom-24 z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-2xl bg-fg px-4 py-3 text-bg shadow-lg"
        >
          <span>{toastState.msg}</span>
          {toastState.action && (
            <button
              className="rounded-lg px-3 py-1 font-semibold underline"
              onClick={() => {
                const a = toastState.action;
                setToast(null);
                void a?.run();
              }}
            >
              {toastState.action.label}
            </button>
          )}
        </div>
      )}
    </Ctx_.Provider>
  );
}
