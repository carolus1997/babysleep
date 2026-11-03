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

/** Bandeja de conflictos: solo aparece si hay alguno esperando decisión. */
export function ConflictsSection() {
  const { ctx, run, toast } = useApp();
  const status = useLive(async () => (await ctx.db.meta.get('sync_status'))?.value as SyncStatus | undefined, [ctx], undefined as SyncStatus | undefined);
  const [items, setItems] = useState<Array<{ c: ConflictRow; title: string }>>([]);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      const rows = await listOpenConflicts(await getSupabaseClient());
      setItems(await Promise.all(rows.map(async (c) => ({ c, title: await describeRow(ctx, c) }))));
    } catch {
      /* sin conexión: se muestra lo último que había */
    }
  };
  // Se recarga al abrir y tras cada sincronización
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, status?.at]);

  if (items.length === 0) return null;

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
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-danger">{t('conflicts.title', { n: items.length })}</h3>
      <p className="mb-2 text-xs text-muted">{t('conflicts.help')}</p>
      <ul className="space-y-3">
        {items.map(({ c, title }) => {
          const view = describeConflict(c, ctx.zone);
          return (
            <li key={c.id} className="rounded-2xl border border-line bg-surface2 p-3 text-sm">
              <p className="font-semibold">{title}</p>
              <p className="mb-2 text-muted">{view.question}</p>
              <div className="flex flex-col gap-2">
                <Btn disabled={busy} onClick={() => decide(c, 'current')}>
                  {view.keep}
                </Btn>
                <Btn disabled={busy} onClick={() => decide(c, 'other')}>
                  {view.other}
                </Btn>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
