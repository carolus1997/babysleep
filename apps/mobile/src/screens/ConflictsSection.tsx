import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext';
import type { Ctx } from '../domain/context';
import { t } from '../i18n/es';
import { describeConflict, listOpenConflicts, resolveConflict, type ConflictRow } from '../sync/conflicts';
import { syncOnce } from '../sync/engine';
import { getSupabaseClient, supabaseTransport } from '../sync/supabase';
import { useLive } from '../ui/hooks';
import { Btn } from '../ui/primitives';
import type { SyncStatus } from '../sync/useAutoSync';

/** Qué registro es, en palabras: «Noche del 14 ene, 20:00 · Lía». */
async function describeRow(ctx: Ctx, c: ConflictRow): Promise<string> {
  if (c.table_name === 'sleep_session') {
    const s = await ctx.db.sleep_session.get(c.row_id);
    if (s === undefined) return 'Una sesión de sueño';
    const baby = await ctx.db.baby.get(s.baby_id);
    const when = new Date(s.sleep_start_utc).toLocaleString('es-ES', { timeZone: ctx.zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `${s.sleep_type === 'night' ? 'Noche' : 'Siesta'} del ${when}${baby ? ` · ${baby.alias}` : ''}`;
  }
  if (c.table_name === 'baby') return `Perfil de ${(await ctx.db.baby.get(c.row_id))?.alias ?? 'un bebé'}`;
  return c.table_name.replace(/_/g, ' ');
}

/** Aplica una decisión y trae enseguida el resultado. */
function useDecide(after: () => void | Promise<void>) {
  const { ctx, run, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const decide = async (c: ConflictRow, use: 'current' | 'other') => {
    setBusy(true);
    try {
      const ok = await run(async () => {
        const client = await getSupabaseClient();
        await resolveConflict(client, c.id, use);
        await syncOnce(ctx, supabaseTransport(client)); // trae enseguida el resultado
        return true;
      });
      if (ok) toast(t('conflicts.resolved'));
      await after();
      return ok === true;
    } finally {
      setBusy(false);
    }
  };
  return { busy, decide };
}

/** Un conflicto con sus dos salidas: dejar lo que hay o usar el otro valor. */
function ConflictChoice({ c, title, busy, onDecide }: { c: ConflictRow; title?: string; busy: boolean; onDecide: (use: 'current' | 'other') => void }) {
  const { ctx } = useApp();
  const view = describeConflict(c, ctx.zone);
  return (
    <div className="rounded-2xl border border-line bg-surface2 p-3 text-sm">
      {title !== undefined && <p className="font-semibold">{title}</p>}
      <p className="mb-2 text-muted">{view.question}</p>
      <div className="flex flex-col gap-2">
        <Btn className="bg-surface!" disabled={busy} onClick={() => onDecide('current')}>
          {view.keep}
        </Btn>
        <Btn className="bg-surface!" disabled={busy} onClick={() => onDecide('other')}>
          {view.other}
        </Btn>
      </div>
    </div>
  );
}

/** El conflicto de UN sueño, dentro de su hoja de edición: se decide aquí, sin ir a Ajustes. */
export function SessionConflict({ sessionId, onResolved }: { sessionId: string; onResolved: () => void }) {
  const { ctx } = useApp();
  const [items, setItems] = useState<ConflictRow[] | 'loading' | 'offline'>('loading');
  const reload = async () => {
    try {
      const client = await getSupabaseClient();
      const rows = (await listOpenConflicts(client)).filter((c) => c.table_name === 'sleep_session' && c.row_id === sessionId);
      setItems(rows);
      // Ya lo resolvió otro móvil: se sincroniza para que desaparezca la marca.
      if (rows.length === 0) await syncOnce(ctx, supabaseTransport(client));
    } catch {
      setItems('offline');
    }
  };
  const { busy, decide } = useDecide(reload);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, sessionId]);

  return (
    <div className="mb-4 space-y-2" role="group" aria-label={t('history.conflict')}>
      <h3 className="text-[13px] font-bold text-danger">{t('conflicts.sessionTitle')}</h3>
      {items === 'loading' && <p className="text-sm text-muted">{t('common.loading')}</p>}
      {items === 'offline' && <p className="text-sm text-muted">{t('conflicts.offline')}</p>}
      {Array.isArray(items) && items.length === 0 && <p className="text-sm text-muted">{t('conflicts.gone')}</p>}
      {Array.isArray(items) &&
        items.map((c) => (
          <ConflictChoice
            key={c.id}
            c={c}
            busy={busy}
            onDecide={async (use) => {
              if ((await decide(c, use)) && items.length === 1) onResolved();
            }}
          />
        ))}
    </div>
  );
}

/** Bandeja de conflictos: solo aparece si hay alguno esperando decisión. */
export function ConflictsSection() {
  const { ctx } = useApp();
  const status = useLive(async () => (await ctx.db.meta.get('sync_status'))?.value as SyncStatus | undefined, [ctx], undefined as SyncStatus | undefined);
  const [items, setItems] = useState<Array<{ c: ConflictRow; title: string }>>([]);

  const reload = async () => {
    try {
      const rows = await listOpenConflicts(await getSupabaseClient());
      setItems(await Promise.all(rows.map(async (c) => ({ c, title: await describeRow(ctx, c) }))));
    } catch {
      /* sin conexión: se muestra lo último que había */
    }
  };
  const { busy, decide } = useDecide(reload);
  // Se recarga al abrir y tras cada sincronización
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, status?.at]);

  if (items.length === 0) return null;

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="mb-1 text-[13px] font-bold text-danger">{t('conflicts.title', { n: items.length })}</h3>
      <p className="mb-2 text-xs text-muted">{t('conflicts.help')}</p>
      <ul className="space-y-3">
        {items.map(({ c, title }) => (
          <li key={c.id}>
            <ConflictChoice c={c} title={title} busy={busy} onDecide={(use) => void decide(c, use)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
