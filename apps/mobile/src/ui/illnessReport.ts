import type { AwakeningT, BabyT, FeedingT, IllnessEntryT, IllnessEpisodeT, MedicationDoseT, MedicationT, SleepSessionT } from '@babysleep/contract';
import {
  diaperCounts,
  episodeDayCount,
  episodeEndMs,
  fmtTemp,
  intakeCounts,
  localDate,
  parseInstant,
  sortEntries,
  symptomSummary,
  temperatureSummary,
  type TempPoint,
} from '@babysleep/core';
import { METRIC_KIND, MIN_DAYS_TO_COMPARE, periodMetrics, type MetricKey } from '../domain/beforeAfter';
import { t, type I18nKey } from '../i18n/es';
import { fmtAges, fmtDur } from './format';
import type { Report } from './report';

export interface IllnessReportInput {
  baby: Pick<BabyT, 'alias' | 'birth_date' | 'gestational_weeks'>;
  episode: IllnessEpisodeT;
  /** Anotaciones de ESTE episodio (vivas). */
  entries: readonly IllnessEntryT[];
  medications: readonly MedicationT[];
  doses: readonly MedicationDoseT[];
  sessions: readonly SleepSessionT[];
  feedings: readonly FeedingT[];
  awakenings: readonly AwakeningT[];
  awakeningThresholdMs: number;
  zone: string;
  nowMs: number;
}

const SITE_KEY: Record<string, I18nKey> = {
  axillary: 'illness.site.axillary',
  rectal: 'illness.site.rectal',
  ear: 'illness.site.ear',
  forehead: 'illness.site.forehead',
  oral: 'illness.site.oral',
  other: 'illness.site.other',
};
const SYMPTOM_KEY: Record<string, I18nKey> = {
  cough: 'illness.symptom.cough',
  runny_nose: 'illness.symptom.runny_nose',
  congestion: 'illness.symptom.congestion',
  sneezing: 'illness.symptom.sneezing',
  vomiting: 'illness.symptom.vomiting',
  diarrhea: 'illness.symptom.diarrhea',
  rash: 'illness.symptom.rash',
  fussy: 'illness.symptom.fussy',
  drowsy: 'illness.symptom.drowsy',
  pain: 'illness.symptom.pain',
  other: 'illness.symptom.other',
};

/** «vie 21 ene 19:00», en la zona de la familia. */
export function whenText(ms: number, zone: string): string {
  const d = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).format(new Date(ms));
  return d.replace(',', '');
}

const siteText = (site: string | null): string => (site !== null && SITE_KEY[site] !== undefined ? ` (${t(SITE_KEY[site]!).toLowerCase()})` : '');
const tempLine = (p: TempPoint, zone: string): string => t('illrep.tempItem', { when: whenText(p.atMs, zone), value: fmtTemp(p.dc), site: siteText(p.site) });

const METRICS: ReadonlyArray<{ key: MetricKey; label: I18nKey }> = [
  { key: 'total', label: 'illrep.mTotal' },
  { key: 'night', label: 'illrep.mNight' },
  { key: 'naps', label: 'illrep.mNaps' },
  { key: 'feeds', label: 'illrep.mFeeds' },
];

const fmtMetric = (key: MetricKey, v: number | null): string => {
  if (v === null) return t('illrep.noValue');
  return METRIC_KIND[key] === 'duration' ? fmtDur(v) : v.toFixed(1);
};

/**
 * Informe de un episodio de enfermedad para enseñárselo al pediatra: lo que la familia anotó (temperatura, síntomas,
 * comida, pañales, notas), la medicación dada con sus horas y cómo fueron el sueño y las tomas frente a la semana
 * anterior. Solo hechos con su n: no dice «fiebre», «normal» ni «grave», ni que el episodio causara los cambios. El CIPA
 * no sale nunca.
 */
export function buildIllnessReport(input: IllnessReportInput): Report {
  const { episode, zone, nowMs } = input;
  const startMs = parseInstant(episode.start_utc);
  const endMs = episodeEndMs(episode, nowMs);
  const entries = sortEntries(input.entries.filter((e) => e.episode_id === episode.id && e.deleted_at === null));
  const ages = fmtAges(input.baby.birth_date, input.baby.gestational_weeks, nowMs);
  const startDate = localDate(startMs, zone);
  const endDate = localDate(endMs, zone);
  const dayCount = episodeDayCount(startDate, endDate);

  // --- temperatura
  const temps = temperatureSummary(entries);
  const temp: string[] = [];
  if (temps.n === 0) temp.push(t('illrep.noTemp'));
  else {
    temp.push(temps.n === 1 ? t('illrep.tempCount1') : t('illrep.tempCount', { n: temps.n }));
    // Con una sola medida no hay «más alta» ni «primera»: basta la lista de abajo.
    if (temps.n > 1) {
      temp.push(t('illrep.tempMax', { line: tempLine(temps.max!, zone) }));
      temp.push(t('illrep.tempMin', { line: tempLine(temps.min!, zone) }));
      temp.push(t('illrep.tempFirst', { line: tempLine(temps.first!, zone) }));
      temp.push(t('illrep.tempLast', { line: tempLine(temps.last!, zone) }));
    }
    for (const e of entries) {
      if (e.kind === 'temperature' && e.temp_dc !== null) {
        temp.push(`${t('illrep.tempItem', { when: whenText(parseInstant(e.at_utc), zone), value: fmtTemp(e.temp_dc), site: siteText(e.temp_site) })}${e.note ? ` · ${e.note}` : ''}`);
      }
    }
  }

  // --- síntomas
  const sym = symptomSummary(entries);
  const symptoms: string[] =
    sym.length === 0
      ? [t('illrep.noSymptoms')]
      : sym.map((s) =>
          t('illrep.symptomLine', {
            name: SYMPTOM_KEY[s.symptom] === undefined ? s.symptom : t(SYMPTOM_KEY[s.symptom]!),
            n: s.count,
            times: s.count === 1 ? t('illrep.time1') : t('illrep.timeN'),
            from: whenText(s.firstMs, zone),
            to: whenText(s.lastMs, zone),
          }),
        );

  // --- comida y pañales
  const ic = intakeCounts(entries);
  const dc = diaperCounts(entries);
  const feeds = input.feedings.filter((f) => f.deleted_at === null && parseInstant(f.start_utc) >= startMs && parseInstant(f.start_utc) <= endMs);
  const intake: string[] = [];
  intake.push(ic.usual + ic.less + ic.much_less + ic.almost_none === 0 ? t('illrep.noIntake') : t('illrep.intakeLine', { u: ic.usual, l: ic.less, m: ic.much_less, a: ic.almost_none }));
  intake.push(t('illrep.feedsApp', { n: feeds.length }));
  intake.push(dc.wet + dc.dirty + dc.both === 0 ? t('illrep.noDiapers') : t('illrep.diapers', { w: dc.wet, d: dc.dirty, b: dc.both }));

  // --- medicación dada durante el episodio (se cruza por la hora)
  const meds = new Map(input.medications.filter((m) => m.deleted_at === null).map((m) => [m.id, m]));
  const given = input.doses
    .filter((d) => d.deleted_at === null && meds.has(d.medication_id) && parseInstant(d.given_utc) >= startMs && parseInstant(d.given_utc) <= endMs)
    .sort((a, b) => parseInstant(a.given_utc) - parseInstant(b.given_utc) || a.id.localeCompare(b.id));
  const medication: string[] = given.length === 0 ? [t('illrep.noMeds')] : [];
  for (const d of given) {
    const m = meds.get(d.medication_id)!;
    medication.push(t('illrep.doseLine', { when: whenText(parseInstant(d.given_utc), zone), name: m.name, dose: d.dose_text ?? m.dose_text }));
  }
  for (const id of [...new Set(given.map((d) => d.medication_id))]) {
    const m = meds.get(id)!;
    medication.push(
      t('illrep.pauta', {
        name: m.name,
        dose: m.dose_text,
        every: m.interval_min === null ? t('illrep.pautaOnDemand') : t('illrep.pautaEvery', { dur: m.interval_min % 60 === 0 ? `${m.interval_min / 60} h` : fmtDur(m.interval_min * 60_000) }),
      }),
    );
  }

  // --- sueño y tomas: los 7 días completos anteriores frente a los días completos del episodio (sin el primero ni el último, que están a medias)
  const sleep: string[] = [];
  const duringDays = Math.max(0, dayCount - 2);
  if (duringDays === 0) sleep.push(t('illrep.sleepNoCompare'));
  else {
    const base = { sessions: input.sessions, feedings: input.feedings, awakenings: input.awakenings, attempts: [], awakeningThresholdMs: input.awakeningThresholdMs, zone, nowMs };
    const before = periodMetrics({ ...base, days: 7 }, startDate);
    const during = periodMetrics({ ...base, days: duringDays }, endDate);
    sleep.push(t('illrep.sleepIntro'));
    for (const m of METRICS) {
      sleep.push(t('illrep.mLine', { label: t(m.label), before: fmtMetric(m.key, before.values[m.key]), nb: before.n[m.key], during: fmtMetric(m.key, during.values[m.key]), nd: during.n[m.key] }));
    }
    if (during.daysWithData < MIN_DAYS_TO_COMPARE) sleep.push(t('illrep.sleepTooFew', { min: MIN_DAYS_TO_COMPARE }));
    sleep.push(t('illrep.sleepNote'));
  }

  // --- notas
  const notes: string[] = [];
  if (episode.notes) notes.push(t('illrep.episodeNotes', { text: episode.notes }));
  for (const e of entries) if (e.kind === 'note' && e.note !== null) notes.push(t('illrep.noteLine', { when: whenText(parseInstant(e.at_utc), zone), text: e.note }));
  for (const e of entries) {
    // notas que acompañan a otro tipo de anotación (síntoma, comida, pañal): también son del pediatra
    if (e.kind !== 'note' && e.kind !== 'temperature' && e.note !== null) notes.push(t('illrep.noteLine', { when: whenText(parseInstant(e.at_utc), zone), text: e.note }));
  }
  if (notes.length === 0) notes.push(t('illrep.noNotes'));

  // --- datos del informe
  const by = (k: IllnessEntryT['kind']) => entries.filter((e) => e.kind === k).length;
  const data = [t('illrep.dataCount', { n: entries.length, t: by('temperature'), s: by('symptom'), i: by('intake'), d: by('diaper'), o: by('note') })];

  const label = episode.title ?? t('illrep.untitled');
  const range = t('illrep.range', { from: whenText(startMs, zone), to: episode.end_utc === null ? t('illrep.ongoing') : whenText(parseInstant(episode.end_utc), zone) });
  return {
    title: t('illrep.title', { name: input.baby.alias }),
    subtitle: t('illrep.subtitle', { label, range, age: ages.age, corrected: ages.corrected === null ? '' : t('report.corrected', { age: ages.corrected }) }),
    sections: [
      { title: t('illrep.s.temp'), lines: temp },
      { title: t('illrep.s.symptoms'), lines: symptoms },
      { title: t('illrep.s.intake'), lines: intake },
      { title: t('illrep.s.meds'), lines: medication },
      { title: t('illrep.s.sleep'), lines: sleep },
      { title: t('illrep.s.notes'), lines: notes },
      { title: t('illrep.s.data'), lines: data },
    ],
    footer: t('illrep.footer'),
  };
}
