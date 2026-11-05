import type { EventCategoryT, LifeEventT, SleepSessionT } from '@babysleep/contract';
import { buildSpans, findOverlaps, localDate, naturalDayTotals, parseInstant } from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { listLifeEvents } from '../domain/notes';
import { listSessions, restoreSession } from '../domain/sleep';
import { t } from '../i18n/es';
import { fmtClock, fmtDayLabel, fmtDur } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Btn, Card } from '../ui/primitives';
import { AwakeningsSheet } from './AwakeningsSheet';
import { NotesSheet } from './NotesSheet';
import { ManualSheet, SessionSheet } from './SessionSheets';

export function History() {
  const { ctx, baby, run } = useApp();
  const babyId = baby?.id ?? '';
  const all = useLive(() => listSessions(ctx, babyId, { includeDeleted: true }), [ctx, babyId], [] as SleepSessionT[]);
  const events = useLive(() => listLifeEvents(ctx, babyId), [ctx, babyId], [] as LifeEventT[]);
  const cats = useLive(() => ctx.db.event_category.toArray(), [ctx], [] as EventCategoryT[]);
  const now = useNow(30_000);
  const [edit, setEdit] = useState<SleepSessionT | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [awake, setAwake] = useState<string | null>(null);
  const [manual, setManual] = useState(false);

  const sessions = useMemo(() => all.filter((s) => s.deleted_at === null), [all]);
  const trashed = useMemo(() => all.filter((s) => s.deleted_at !== null), [all]);
  const overlapIds = useMemo(() => {
    const ids = new Set<string>();
    for (const o of findOverlaps(buildSpans(sessions, { nowMs: now }).spans)) {
      ids.add(o.a);
      ids.add(o.b);
    }
    return ids;
  }, [sessions, now]);

  const groups = useMemo(() => {
    const m = new Map<string, SleepSessionT[]>();
    for (const s of [...sessions].reverse()) {
      const d = localDate(parseInstant(s.sleep_start_utc), ctx.zone);
      m.set(d, [...(m.get(d) ?? []), s]);
    }
    return [...m.entries()];
  }, [sessions, ctx.zone]);

  if (baby === null) return null;
  const catName = (id: string) => cats.find((c) => c.id === id)?.label_i18n['es'] ?? '';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('history.title')}</h1>
        <Btn variant="primary" onClick={() => setManual(true)}>
          + {t('history.add')}
        </Btn>
      </div>

      {groups.length === 0 && <p className="py-8 text-center text-muted">{t('history.empty')}</p>}

      {groups.map(([date, list]) => {
        const total = naturalDayTotals(sessions, date, ctx.zone, { nowMs: now }).totalMs;
        const dayEvents = events.filter((e) => date >= e.start_date && date <= (e.end_date ?? e.start_date));
        return (
          <Card key={date}>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="font-semibold capitalize">{fmtDayLabel(date)}</h2>
              <span className="text-sm text-muted">{fmtDur(total)}</span>
            </div>
            {dayEvents.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1" aria-label={t('history.events')}>
                {dayEvents.map((e) => (
                  <span key={e.id} className="rounded-full bg-surface2 px-2 py-1 text-xs">
                    ◆ {catName(e.category_id)}
                    {e.description ? ` · ${e.description}` : ''}
                  </span>
                ))}
              </div>
            )}
            <ul className="divide-y divide-line">
              {list.map((s) => {
                const startMs = parseInstant(s.sleep_start_utc);
                const endMs = s.sleep_end_utc ? parseInstant(s.sleep_end_utc) : null;
                const approx = s.start_quality === 'approx' || s.end_quality === 'approx';
                return (
                  <li key={s.id}>
                    <button className="flex min-h-14 w-full items-center justify-between gap-2 py-2 text-left" onClick={() => setEdit(s)}>
                      <span>
                        <span className="font-medium">
                          {approx && <span title={t('history.approx')}>~</span>}
                          {fmtClock(startMs, s.start_tz)} – {endMs ? fmtClock(endMs, s.end_tz ?? ctx.zone) : t('history.open')}
                        </span>
                        <span className="ml-2 rounded-full bg-surface2 px-2 py-0.5 text-xs text-muted">
                          {t(s.sleep_type === 'nap' ? 'home.type.nap' : 'home.type.night')}
                        </span>
                        {s.conflict_open && (
                          <span className="ml-1 rounded-full bg-surface2 px-2 py-0.5 text-xs font-semibold text-danger" title={t('history.conflictHint')}>
                            {t('history.conflict')}
                          </span>
                        )}
                        {overlapIds.has(s.id) && (
                          <span role="img" aria-label={t('history.overlap')} title={t('history.overlap')} className="ml-1 text-danger">
                            ⚠
                          </span>
                        )}
                      </span>
                      <span className="font-semibold">{endMs ? fmtDur(endMs - startMs) : fmtDur(now - startMs)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}

      {trashed.length > 0 && (
        <details className="rounded-3xl border border-line bg-surface p-4">
          <summary className="cursor-pointer font-medium">
            {t('history.trash')} ({trashed.length})
          </summary>
          <ul className="mt-2 divide-y divide-line">
            {trashed.map((s) => (
              <li key={s.id} className="flex min-h-12 items-center justify-between py-1 text-sm">
                <span>
                  {localDate(parseInstant(s.sleep_start_utc), ctx.zone)} · {fmtClock(parseInstant(s.sleep_start_utc), s.start_tz)}
                </span>
                <Btn variant="ghost" onClick={() => run(() => restoreSession(ctx, s.id))}>
                  {t('session.restore')}
                </Btn>
              </li>
            ))}
          </ul>
        </details>
      )}

      {edit && (
        <SessionSheet
          key={edit.id + edit.rev}
          session={sessions.find((s) => s.id === edit.id) ?? edit}
          onClose={() => setEdit(null)}
          onNotes={() => {
            setNotes(edit.id);
            setEdit(null);
          }}
          onAwakenings={() => {
            setAwake(edit.id);
            setEdit(null);
          }}
        />
      )}
      {notes && <NotesSheet target={{ sessionId: notes }} onClose={() => setNotes(null)} />}
      {awake && sessions.find((s) => s.id === awake) && <AwakeningsSheet session={sessions.find((s) => s.id === awake) as SleepSessionT} onClose={() => setAwake(null)} />}
      {manual && <ManualSheet babyId={baby.id} onClose={() => setManual(false)} />}
    </div>
  );
}
