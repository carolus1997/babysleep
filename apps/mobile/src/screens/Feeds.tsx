import type { FeedingT } from '@babysleep/contract';
import { localDate, parseInstant } from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { listFeedings, summarizeFeedings } from '../domain/feeding';
import type { ObservationTarget } from '../domain/notes';
import { t } from '../i18n/es';
import { fmtClock, fmtDayLabel, fmtDur } from '../ui/format';
import { useLive } from '../ui/hooks';
import { Btn, Card } from '../ui/primitives';
import { dayLine } from './FeedingCard';
import { FeedingSheet, FeedLabel, ManualFeedingSheet } from './FeedingSheets';
import { NotesSheet } from './NotesSheet';

/** Pestaña «Tomas»: historial por días, con el resumen de cada día y la posibilidad de añadir o corregir. */
export function Feeds() {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const feedings = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const [edit, setEdit] = useState<FeedingT | null>(null);
  const [notes, setNotes] = useState<ObservationTarget | null>(null);
  const [manual, setManual] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<string, FeedingT[]>();
    for (const f of [...feedings].reverse()) {
      const d = localDate(parseInstant(f.start_utc), ctx.zone);
      m.set(d, [...(m.get(d) ?? []), f]);
    }
    return [...m.entries()];
  }, [feedings, ctx.zone]);

  if (baby === null) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('feed.title')}</h1>
        <Btn variant="primary" onClick={() => setManual(true)}>
          + {t('feed.add')}
        </Btn>
      </div>

      {groups.length === 0 && <p className="py-8 text-center text-muted">{t('feed.empty')}</p>}

      {groups.map(([date, list]) => (
        <Card key={date}>
          <div className="mb-2">
            <h2 className="font-semibold capitalize">{fmtDayLabel(date)}</h2>
            <p className="text-sm text-muted">{dayLine(summarizeFeedings(feedings, date, ctx.zone))}</p>
          </div>
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
                    <span className="font-semibold">{endMs ? fmtDur(endMs - startMs) : t('history.open')}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}

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
