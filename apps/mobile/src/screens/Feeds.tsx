import type { FeedingT } from '@babysleep/contract';
import { localDate, parseInstant } from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { splitRecentAndWeeks } from '../domain/dayGroups';
import { listFeedings, summarizeFeedings } from '../domain/feeding';
import type { ObservationTarget } from '../domain/notes';
import { t } from '../i18n/es';
import { fmtClock, fmtDayLabel, fmtDur, fmtWeekRange } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Disclosure, ExpandBar, useOpenSet } from '../ui/Disclosure';
import { Btn } from '../ui/primitives';
import { dayLine } from './FeedingCard';
import { FeedingSheet, FeedLabel, ManualFeedingSheet } from './FeedingSheets';
import { NotesSheet } from './NotesSheet';

/** Pestaña «Tomas»: historial por días en desplegables (hoy abierto, con el resumen de cada día) y las semanas antiguas agrupadas. */
export function Feeds() {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const feedings = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const [edit, setEdit] = useState<FeedingT | null>(null);
  const [notes, setNotes] = useState<ObservationTarget | null>(null);
  const [manual, setManual] = useState(false);

  const now = useNow(60_000);

  const groups = useMemo(() => {
    const m = new Map<string, FeedingT[]>();
    for (const f of [...feedings].reverse()) {
      const d = localDate(parseInstant(f.start_utc), ctx.zone);
      m.set(d, [...(m.get(d) ?? []), f]);
    }
    return m;
  }, [feedings, ctx.zone]);

  const todayDate = localDate(now, ctx.zone);
  const dates = useMemo(() => [...groups.keys()], [groups]);
  const { recent, weeks } = useMemo(() => splitRecentAndWeeks(dates, todayDate), [dates, todayDate]);
  // Abierto por defecto: el día más reciente. Lo demás, cerrado con su resumen a la vista.
  const open = useOpenSet(dates.length > 0 ? [dates[0] as string] : []);
  const allIds = useMemo(() => [...dates, ...weeks.map((w) => `w${w.key}`)], [dates, weeks]);

  if (baby === null) return null;

  const renderDay = (date: string) => {
    const list = groups.get(date) ?? [];
    return (
      <Disclosure
        key={date}
        title={<span className="capitalize">{date === todayDate ? `${t('history.today')} · ` : ''}{fmtDayLabel(date)}</span>}
        summary={dayLine(summarizeFeedings(feedings, date, ctx.zone))}
        open={open.isOpen(date)}
        onToggle={() => open.toggle(date)}
      >
        <ul className="divide-y divide-line">
          {list.map((f) => {
            const startMs = parseInstant(f.start_utc);
            const endMs = f.end_utc ? parseInstant(f.end_utc) : null;
            const approx = f.start_quality === 'approx' || f.end_quality === 'approx';
            const detail = [
              f.breast_side ? t(`feed.side.${f.breast_side}` as 'feed.side.left') : null,
              f.amount_ml !== null ? `${f.amount_ml} ml` : null,
            ].filter(Boolean);
            return (
              <li key={f.id}>
                <button className="flex min-h-14 w-full items-center justify-between gap-2 py-2 text-left" onClick={() => setEdit(f)}>
                  <span>
                    <span className="font-medium">
                      {approx && <span title={t('history.approx')}>~</span>}
                      {fmtClock(startMs, f.start_tz)}
                    </span>
                    <span className="ml-2 rounded-full bg-surface2 px-2 py-0.5 text-xs">
                      <FeedLabel type={f.feed_type} />
                    </span>
                    {detail.length > 0 && <span className="ml-2 text-sm text-muted">{detail.join(' · ')}</span>}
                  </span>
                  <span className="font-semibold">{endMs ? fmtDur(endMs - startMs) : f.source === 'timer' ? t('history.open') : <span className="text-sm font-normal text-muted">{t('feed.durationUnknown')}</span>}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </Disclosure>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('feed.title')}</h1>
        <Btn variant="primary" onClick={() => setManual(true)}>
          + {t('feed.add')}
        </Btn>
      </div>

      {dates.length === 0 && <p className="py-8 text-center text-muted">{t('feed.empty')}</p>}

      {dates.length > 0 && (
        <ExpandBar label={t('feed.byDays')} anyOpen={open.anyOpen(allIds)} onExpand={() => open.openAll(allIds)} onCollapse={open.closeAll} />
      )}

      <div className="space-y-2.5">
        {recent.map(renderDay)}
        {weeks.map((w) => {
          const avg = w.dates.reduce((n, d) => n + summarizeFeedings(feedings, d, ctx.zone).count, 0) / Math.max(1, w.dates.length);
          return (
            <Disclosure
              key={w.key}
              title={fmtWeekRange(w.start, w.end)}
              summary={t('feed.weekSummary', { n: w.dates.length, avg: avg.toFixed(1).replace('.', ',') })}
              open={open.isOpen(`w${w.key}`)}
              onToggle={() => open.toggle(`w${w.key}`)}
            >
              <div className="space-y-2.5 pt-2">{w.dates.map(renderDay)}</div>
            </Disclosure>
          );
        })}
      </div>

      {manual && <ManualFeedingSheet babyId={baby.id} onClose={() => setManual(false)} />}
      {edit && (
        <FeedingSheet
          feeding={edit}
          onClose={() => setEdit(null)}
          onNotes={() => {
            setNotes({ feedingId: edit.id });
            setEdit(null);
          }}
        />
      )}
      {notes && <NotesSheet target={notes} onClose={() => setNotes(null)} />}
    </div>
  );
}
