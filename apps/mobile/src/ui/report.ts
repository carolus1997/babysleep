import type { AwakeningT, BabyT, FeedingT, SleepSessionT } from '@babysleep/contract';
import { analyzeFeeding, MS_PER_24H, type CircularStats, type WindowStats } from '@babysleep/core';
import { buildOverview } from '../domain/overview';
import { buildRhythm } from '../domain/rhythm';
import { t } from '../i18n/es';
import { fmtAges, fmtDur, fmtMinuteOfDay } from './format';

export interface ReportSection {
  title: string;
  lines: string[];
}

export interface Report {
  title: string;
  subtitle: string;
  sections: ReportSection[];
  footer: string;
}

export interface ReportInput {
  baby: Pick<BabyT, 'alias' | 'birth_date' | 'gestational_weeks'>;
  sessions: readonly SleepSessionT[];
  feedings: readonly FeedingT[];
  awakenings: readonly AwakeningT[];
  awakeningThresholdMs: number;
  zone: string;
  nowMs: number;
}

const win = (label: string, s: WindowStats): string => `${label}: ${s.meanMs === null ? t('report.noData') : `${fmtDur(s.meanMs)} (n=${s.n})`}`;
const clock = (label: string, s: CircularStats): string =>
  `${label}: ${s.meanMinute === null ? t('report.noData') : `${fmtMinuteOfDay(s.meanMinute)}${s.sdMinutes === null ? '' : ` ± ${Math.round(s.sdMinutes)} min`} (n=${s.n})`}`;

/**
 * Informe de los últimos 7 días completos, pensado para enseñárselo al pediatra. Solo cifras descriptivas con su n y
 * la calidad del dato; no interpreta ni diagnostica, y lo que no se sabe se dice («sin datos»), nunca se pone a cero.
 */
export function buildReport(input: ReportInput): Report {
  const { zone, nowMs } = input;
  const o = buildOverview({
    sessions: input.sessions,
    attempts: [],
    awakenings: input.awakenings,
    awakeningThresholdMs: input.awakeningThresholdMs,
    zone,
    nowMs,
    days: 7,
  });
  const rh = buildRhythm({ sessions: input.sessions, zone, nowMs, days: 7 });
  const w = rh.current.windows;
  const r = rh.current.rhythm;
  const f = analyzeFeeding({ feedings: input.feedings, sessions: input.sessions, zone, fromMs: nowMs - 7 * MS_PER_24H, toMs: nowMs + 1, nowMs });
  const first = o.series[0]?.date ?? '';
  const last = o.series[o.series.length - 1]?.date ?? '';
  const ages = fmtAges(input.baby.birth_date, input.baby.gestational_weeks, nowMs);

  const sleep: string[] = [t('report.daysWithData', { d: o.daysWithData })];
  if (o.meanDailyTotalMs !== null) {
    sleep.push(
      t('report.sleepMean', {
        total: fmtDur(o.meanDailyTotalMs),
        nap: o.meanNapTotalMs === null ? '—' : fmtDur(o.meanNapTotalMs),
        night: o.meanNightTotalMs === null ? '—' : fmtDur(o.meanNightTotalMs),
      }),
    );
    if (o.meanNapsPerDay !== null) sleep.push(t('report.napsPerDay', { n: o.meanNapsPerDay.toFixed(1) }));
  }
  sleep.push(
    o.awakeningNights === 0
      ? t('report.awakeNone')
      : t('report.awakeMean', {
          n: (o.meanAwakeningsPerNight ?? 0).toFixed(1),
          long: (o.meanLongAwakeningsPerNight ?? 0).toFixed(1),
          nights: o.awakeningNights,
          thr: Math.round(input.awakeningThresholdMs / 60_000),
        }),
  );

  const feeds: string[] = [];
  if (f.count === 0) feeds.push(t('report.noFeeds'));
  else {
    feeds.push(t('report.feedsPerDay', { n: f.meanPerDay === null ? '—' : f.meanPerDay.toFixed(1), d: f.daysObserved }));
    feeds.push(
      t('report.feedInterval', {
        med: f.intervals.medianMs === null ? t('report.noData') : fmtDur(f.intervals.medianMs),
        n: f.intervals.n,
      }),
    );
    feeds.push(t('report.feedTypes', { b: f.byType.breast, bt: f.byType.bottle, m: f.byType.mixed, s: f.byType.solids }));
    if (f.bottle.meanMl !== null) feeds.push(t('report.bottleMl', { ml: Math.round(f.bottle.meanMl), k: f.bottle.withMl, n: f.bottle.n }));
    if (f.nights.meanPerNight !== null) feeds.push(t('report.nightFeeds', { n: f.nights.meanPerNight.toFixed(1), nights: f.nights.n }));
  }

  const q = o.quality;
  const quality = [
    t('report.qSessions', { n: q.sessionsInRange, approx: q.approxTimes }),
    t('report.qOpen', { open: q.openSessions, over: q.overlapsPending }),
    t('report.qWindows', { long: w.tooLong, over: w.overlapping }),
    t('report.qFeedUnknown', { n: f.durationUnknown }),
  ];

  return {
    title: t('report.title', { name: input.baby.alias }),
    subtitle: t('report.subtitle', {
      from: first,
      to: last,
      age: ages.age,
      corrected: ages.corrected === null ? '' : t('report.corrected', { age: ages.corrected }),
    }),
    sections: [
      { title: t('report.s.sleep'), lines: sleep },
      {
        title: t('report.s.windows'),
        lines: [win(t('rhythm.win.first'), w.first), win(t('rhythm.win.between'), w.between), win(t('rhythm.win.bedtime'), w.bedtime)],
      },
      { title: t('report.s.rhythm'), lines: [clock(t('rhythm.bedtime'), r.bedtime), clock(t('rhythm.wakeUp'), r.wakeUp), clock(t('rhythm.firstNap'), r.firstNap)] },
      { title: t('report.s.feeds'), lines: feeds },
      { title: t('report.s.quality'), lines: quality },
    ],
    footer: t('report.footer'),
  };
}

export function reportToText(rep: Report): string {
  const out = [rep.title, rep.subtitle, ''];
  for (const s of rep.sections) out.push(s.title.toUpperCase(), ...s.lines.map((l) => `- ${l}`), '');
  out.push(rep.footer);
  return out.join('\n');
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Documento HTML autónomo (sin scripts ni recursos externos), listo para imprimir o guardar como PDF. */
export function reportToHtml(rep: Report): string {
  const body = rep.sections
    .map((s) => `<h2>${esc(s.title)}</h2><ul>${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`)
    .join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(rep.title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#161a2e}h1{margin-bottom:.2rem}h2{font-size:.95rem;text-transform:uppercase;letter-spacing:.04em;color:#565c78;border-bottom:1px solid #d9dcec;padding-bottom:.2rem;margin-top:1.6rem}.sub{color:#565c78;margin-top:0}li{margin:.25rem 0}footer{margin-top:2rem;font-size:.85rem;color:#565c78}</style></head>
<body><h1>${esc(rep.title)}</h1><p class="sub">${esc(rep.subtitle)}</p>${body}<footer>${esc(rep.footer)}</footer></body></html>`;
}
