import type { AwakeningT, FeedingT, SleepSessionT } from '@babysleep/contract';
import { buildTimeline, localDate, naturalDayWindow, parseInstant, type TimelineEventInput } from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { listAwakenings } from '../domain/awakening';
import { listFeedings } from '../domain/feeding';
import { listSessions } from '../domain/sleep';
import { t } from '../i18n/es';
import { useLive, useNow } from '../ui/hooks';
import { Card, Chip } from '../ui/primitives';

const RANGES = [7, 14] as const;
const HOURS = [0, 6, 12, 18, 24] as const;

/** `2027-01-15` → «vie 15». */
const fmtDayShort = (date: string): string =>
  new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)).replace(',', '');

/** Módulo de análisis 2: cada día en una franja de 24 h, con sueño, tomas y despertares a la vez. */
export function Timeline() {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const feedings = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const awakenings = useLive(() => listAwakenings(ctx, babyId), [ctx, babyId], [] as AwakeningT[]);
  const now = useNow(60_000);

  const rows = useMemo(() => {
    const today = localDate(now, ctx.zone);
    const dates = [today];
    for (let i = 1; i < days; i++) dates.push(localDate(naturalDayWindow(dates[i - 1] as string, ctx.zone).startMs - 1, ctx.zone));
    const events: TimelineEventInput[] = [
      ...feedings.map((f) => ({ id: f.id, kind: 'feed' as const, startMs: parseInstant(f.start_utc), endMs: f.end_utc === null ? null : parseInstant(f.end_utc) })),
      ...awakenings
        .filter((a) => a.deleted_at === null)
        .map((a) => ({ id: a.id, kind: 'awakening' as const, startMs: parseInstant(a.start_utc), endMs: a.end_utc === null ? null : parseInstant(a.end_utc) })),
    ];
    return buildTimeline({ sessions, events, dates, zone: ctx.zone, nowMs: now });
  }, [sessions, feedings, awakenings, ctx.zone, now, days]);

  if (baby === null) return null;
  const anyData = rows.some((r) => r.bars.length > 0 || r.marks.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex gap-1" role="group" aria-label={t('timeline.title')}>
        {RANGES.map((x) => (
          <Chip key={x} active={days === x} onClick={() => setDays(x)}>
            {x}d
          </Chip>
        ))}
      </div>

      <Card title={t('timeline.title')}>
        {!anyData ? (
          <p className="text-sm text-muted">{t('timeline.empty')}</p>
        ) : (
          <>
            <div className="mb-1 flex pl-14 text-[11px] text-muted" aria-hidden>
              <div className="relative h-3 flex-1">
                {HOURS.map((h) => (
                  <span key={h} className="absolute -translate-x-1/2" style={{ left: `${(h / 24) * 100}%` }}>
                    {h}
                  </span>
                ))}
              </div>
            </div>
            <ul className="space-y-1">
              {rows.map((r) => (
                <li key={r.date} className="flex items-center gap-2" aria-label={`${fmtDayShort(r.date)}: ${r.bars.length} descansos, ${r.marks.filter((m) => m.kind === 'feed').length} tomas`}>
                  <span className="w-12 shrink-0 text-[11px] leading-tight text-muted">{fmtDayShort(r.date)}</span>
                  <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-surface2" aria-hidden>
                    {HOURS.slice(1, -1).map((h) => (
                      <span key={h} className="absolute inset-y-0 w-px bg-line" style={{ left: `${(h / 24) * 100}%` }} />
                    ))}
                    {r.bars.map((b) => (
                      <span
                        key={b.id + r.date}
                        className={`absolute inset-y-1 ${b.type === 'night' ? 'bg-night' : 'bg-nap'} ${b.continuesBefore ? '' : 'rounded-l-sm'} ${b.continuesAfter ? '' : 'rounded-r-sm'} ${b.open ? 'opacity-70' : ''}`}
                        style={{ left: `${b.from * 100}%`, width: `${Math.max(0.5, (b.to - b.from) * 100)}%` }}
                      />
                    ))}
                    {r.marks
                      .filter((m) => m.kind === 'awakening')
                      .map((m) =>
                        m.to === null ? (
                          <span key={m.id} className="absolute inset-y-0 w-px bg-bg" style={{ left: `${m.from * 100}%` }} />
                        ) : (
                          <span key={m.id} className="absolute inset-y-1 bg-bg" style={{ left: `${m.from * 100}%`, width: `${Math.max(0.5, (m.to - m.from) * 100)}%` }} />
                        ),
                      )}
                    {r.marks
                      .filter((m) => m.kind === 'feed')
                      .map((m) => (
                        <span
                          key={m.id}
                          className={`absolute top-0 h-2 rounded-b-sm bg-fg ${m.to === null ? 'w-0.5 opacity-60' : ''}`}
                          style={{ left: `${m.from * 100}%`, ...(m.to === null ? {} : { width: `${Math.max(0.6, (m.to - m.from) * 100)}%` }) }}
                        />
                      ))}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
              <span>
                <span className="mr-1 inline-block size-2 rounded-sm bg-nap" />
                {t('home.type.nap')}
              </span>
              <span>
                <span className="mr-1 inline-block size-2 rounded-sm bg-night" />
                {t('home.type.night')}
              </span>
              <span>
                <span className="mr-1 inline-block h-2 w-1 bg-fg" />
                {t('timeline.feed')}
              </span>
              <span>
                <span className="mr-1 inline-block size-2 rounded-sm border border-line bg-bg" />
                {t('timeline.awakening')}
              </span>
            </p>
            <p className="mt-2 text-xs text-muted">{t('timeline.hint')}</p>
          </>
        )}
      </Card>
      <p className="text-xs text-muted">{t('stats.disclaimer')}</p>
    </div>
  );
}
