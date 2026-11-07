import type { AwakeningT, DiaperKindT, FeedingT, IllnessEntryKindT, IllnessEntryT, IllnessEpisodeT, IntakeT, MedicationDoseT, MedicationT, SleepSessionT, SymptomT, TempSiteT } from '@babysleep/contract';
import { episodeDayCount, episodeEndMs, fmtTemp, localDate, parseInstant, temperatureSeries } from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { listAwakenings, thresholdMs } from '../domain/awakening';
import { listFeedings } from '../domain/feeding';
import {
  addEntry,
  DIAPERS,
  deleteEntry,
  deleteEpisode,
  editEntry,
  editEpisode,
  endEpisode,
  INTAKES,
  listEntries,
  listEpisodes,
  reopenEpisode,
  restoreEntry,
  restoreEpisode,
  startEpisode,
  SYMPTOMS,
  TEMP_SITES,
} from '../domain/illness';
import { listDoses, listMedications } from '../domain/medication';
import { listSessions, localToMs } from '../domain/sleep';
import { t, type I18nKey } from '../i18n/es';
import { fmtDur, toLocalInput } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { buildIllnessReport, whenText } from '../ui/illnessReport';
import { Btn, Card, Chip, Field, inputCls, Sheet } from '../ui/primitives';
import { parseDecimal } from './Growth';
import { ReportView } from './Report';
import { TimeField, timeReady, type Choice } from './TimeField';

const KIND_KEY: Record<IllnessEntryKindT, I18nKey> = {
  temperature: 'illness.kind.temperature',
  symptom: 'illness.kind.symptom',
  intake: 'illness.kind.intake',
  diaper: 'illness.kind.diaper',
  note: 'illness.kind.note',
};
const KIND_ICON: Record<IllnessEntryKindT, string> = { temperature: '🌡', symptom: '😷', intake: '🍼', diaper: '🧷', note: '✎' };
const SITE_KEY: Record<TempSiteT, I18nKey> = {
  axillary: 'illness.site.axillary',
  rectal: 'illness.site.rectal',
  ear: 'illness.site.ear',
  forehead: 'illness.site.forehead',
  oral: 'illness.site.oral',
  other: 'illness.site.other',
};
const SYMPTOM_KEY: Record<SymptomT, I18nKey> = {
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
const INTAKE_KEY: Record<IntakeT, I18nKey> = {
  usual: 'illness.intake.usual',
  less: 'illness.intake.less',
  much_less: 'illness.intake.much_less',
  almost_none: 'illness.intake.almost_none',
};
const DIAPER_KEY: Record<DiaperKindT, I18nKey> = { wet: 'illness.diaper.wet', dirty: 'illness.diaper.dirty', both: 'illness.diaper.both' };

const MIN = 60_000;
const dayLabel = (ms: number, zone: string): string =>
  new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: zone }).format(new Date(ms));
const clockOf = (ms: number, zone: string): string => new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).format(new Date(ms));
const siteText = (s: TempSiteT | null): string => (s === null ? '' : ` · ${t(SITE_KEY[s]).toLowerCase()}`);
const daysText = (n: number): string => (n === 1 ? t('illness.day1') : t('illness.dayN', { n }));

/** Qué dice una anotación, en una línea. */
export function entryText(e: IllnessEntryT): string {
  switch (e.kind) {
    case 'temperature':
      return `${fmtTemp(e.temp_dc ?? 0)}${siteText(e.temp_site)}`;
    case 'symptom':
      return e.symptom === null ? '' : t(SYMPTOM_KEY[e.symptom]);
    case 'intake':
      return e.intake === null ? '' : t(INTAKE_KEY[e.intake]);
    case 'diaper':
      return e.diaper === null ? '' : t(DIAPER_KEY[e.diaper]);
    case 'note':
      return e.note ?? '';
  }
}

// ------------------------------------------------------------------ episodio

function EpisodeSheet({ babyId, edit, onClose }: { babyId: string; edit: IllnessEpisodeT | null; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const [title, setTitle] = useState(edit?.title ?? '');
  const [since, setSince] = useState(edit ? toLocalInput(parseInstant(edit.start_utc), edit.start_tz) : toLocalInput(ctx.now(), ctx.zone));
  const [sinceChoice, setSinceChoice] = useState<Choice>(undefined);
  const [hasEnd, setHasEnd] = useState(edit?.end_utc != null);
  const [until, setUntil] = useState(edit?.end_utc ? toLocalInput(parseInstant(edit.end_utc), edit.start_tz) : '');
  const [untilChoice, setUntilChoice] = useState<Choice>(undefined);
  const [notes, setNotes] = useState(edit?.notes ?? '');
  const ready = timeReady(since, ctx.zone, sinceChoice) && (!hasEnd || (until !== '' && timeReady(until, ctx.zone, untilChoice)));

  const save = async () => {
    const ok = await run(async () => {
      if (edit === null) {
        await startEpisode(ctx, { babyId, title, startLocal: since, ...(sinceChoice === undefined ? {} : { startChoice: sinceChoice }), notes });
      } else {
        await editEpisode(ctx, edit.id, {
          title,
          startLocal: since,
          ...(sinceChoice === undefined ? {} : { startChoice: sinceChoice }),
          endLocal: hasEnd ? until : null,
          ...(untilChoice === undefined ? {} : { endChoice: untilChoice }),
          notes,
        });
      }
      return true;
    });
    if (ok) {
      toast(t('illness.saved'));
      onClose();
    }
  };

  return (
    <Sheet title={edit ? t('illness.edit') : t('illness.new')} onClose={onClose}>
      <Field label={t('illness.title')}>
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder={t('illness.titlePlaceholder')} />
      </Field>
      <TimeField label={t('illness.since')} value={since} onChange={setSince} choice={sinceChoice} onChoice={setSinceChoice} zone={ctx.zone} />
      {edit !== null && (
        <>
          <div className="mb-3">
            <Chip active={hasEnd} onClick={() => setHasEnd((x) => !x)}>
              {t('illness.hasEnd')}
            </Chip>
          </div>
          {hasEnd && <TimeField label={t('illness.until')} value={until} onChange={setUntil} choice={untilChoice} onChoice={setUntilChoice} zone={ctx.zone} />}
        </>
      )}
      <Field label={t('illness.notes')}>
        <textarea className={`${inputCls} py-2`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </Field>
      <div className="flex flex-col gap-2">
        <Btn variant="primary" disabled={!ready} onClick={save}>
          {t('common.save')}
        </Btn>
        <Btn variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Btn>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- anotación

/** Anotar (o editar) una temperatura, un síntoma, lo que come, un pañal o una nota. */
function EntrySheet({ episode, kind, edit, onClose }: { episode: IllnessEpisodeT; kind: IllnessEntryKindT; edit: IllnessEntryT | null; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const initial = useMemo(() => toLocalInput(edit ? parseInstant(edit.at_utc) : ctx.now(), edit ? edit.at_tz : ctx.zone), [ctx, edit]);
  const [when, setWhen] = useState(initial);
  const [choice, setChoice] = useState<Choice>(undefined);
  const [temp, setTemp] = useState(edit?.temp_dc != null ? String(edit.temp_dc / 10).replace('.', ',') : '');
  const [site, setSite] = useState<TempSiteT | null>(edit?.temp_site ?? null);
  const [symptom, setSymptom] = useState<SymptomT | null>(edit?.symptom ?? null);
  const [intake, setIntake] = useState<IntakeT | null>(edit?.intake ?? null);
  const [diaper, setDiaper] = useState<DiaperKindT | null>(edit?.diaper ?? null);
  const [note, setNote] = useState(edit?.note ?? '');
  const [bad, setBad] = useState(false);

  const tempValue = parseDecimal(temp);
  const needsValue =
    (kind === 'temperature' && (tempValue === null || Number.isNaN(tempValue))) ||
    (kind === 'symptom' && symptom === null) ||
    (kind === 'intake' && intake === null) ||
    (kind === 'diaper' && diaper === null) ||
    (kind === 'note' && note.trim() === '');
  const ready = timeReady(when, ctx.zone, choice) && !needsValue;

  /** Sin tocar la hora, es «ahora» exacto; si se cambia, la hora escrita. */
  const atMs = (): number => {
    if (when === initial) return edit ? parseInstant(edit.at_utc) : ctx.now();
    return localToMs(when, ctx.zone, choice);
  };

  const save = async () => {
    let dc = 0;
    if (kind === 'temperature') {
      dc = Math.round((tempValue ?? 0) * 10);
      if (dc < 340 || dc > 430) return setBad(true);
    }
    setBad(false);
    const ok = await run(async () => {
      const at = atMs();
      if (edit === null) {
        const common = { episodeId: episode.id, atMs: at, note };
        if (kind === 'temperature') await addEntry(ctx, { ...common, kind, tempDc: dc, site });
        else if (kind === 'symptom') await addEntry(ctx, { ...common, kind, symptom: symptom! });
        else if (kind === 'intake') await addEntry(ctx, { ...common, kind, intake: intake! });
        else if (kind === 'diaper') await addEntry(ctx, { ...common, kind, diaper: diaper! });
        else await addEntry(ctx, { ...common, kind: 'note', note });
      } else {
        await editEntry(ctx, edit.id, {
          atMs: at,
          note,
          ...(kind === 'temperature' ? { tempDc: dc, site } : {}),
          ...(kind === 'symptom' ? { symptom: symptom! } : {}),
          ...(kind === 'intake' ? { intake: intake! } : {}),
          ...(kind === 'diaper' ? { diaper: diaper! } : {}),
        });
      }
      return true;
    });
    if (ok) {
      toast(t('illness.entrySaved'));
      onClose();
    }
  };

  return (
    <Sheet title={`${edit ? t('illness.entryEdit') : t('illness.addTitle')} · ${t(KIND_KEY[kind])}`} onClose={onClose}>
      <TimeField label={t('illness.when')} value={when} onChange={setWhen} choice={choice} onChoice={setChoice} zone={ctx.zone} />
      {kind === 'temperature' && (
        <>
          <Field label={t('illness.temp')}>
            <input className={inputCls} inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} placeholder="38,4" />
          </Field>
          <p className="-mt-2 mb-3 text-xs text-muted">{t('illness.tempHint')}</p>
          <div className="mb-3" role="group" aria-label={t('illness.site')}>
            <span className="mb-1 block text-sm font-medium text-muted">{t('illness.site')}</span>
            <div className="flex flex-wrap gap-2">
              {TEMP_SITES.map((s) => (
                <Chip key={s} active={site === s} onClick={() => setSite(site === s ? null : s)}>
                  {t(SITE_KEY[s])}
                </Chip>
              ))}
            </div>
          </div>
        </>
      )}
      {kind === 'symptom' && (
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t('illness.kind.symptom')}>
          {SYMPTOMS.map((s) => (
            <Chip key={s} active={symptom === s} onClick={() => setSymptom(s)}>
              {t(SYMPTOM_KEY[s])}
            </Chip>
          ))}
        </div>
      )}
      {kind === 'intake' && (
        <div className="mb-3 flex flex-col gap-2" role="group" aria-label={t('illness.kind.intake')}>
          {INTAKES.map((s) => (
            <Chip key={s} active={intake === s} onClick={() => setIntake(s)}>
              {t(INTAKE_KEY[s])}
            </Chip>
          ))}
        </div>
      )}
      {kind === 'diaper' && (
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t('illness.kind.diaper')}>
          {DIAPERS.map((s) => (
            <Chip key={s} active={diaper === s} onClick={() => setDiaper(s)}>
              {t(DIAPER_KEY[s])}
            </Chip>
          ))}
        </div>
      )}
      <Field label={kind === 'note' ? t('illness.noteLabel') : t('illness.noteExtra')}>
        <textarea className={`${inputCls} py-2`} rows={kind === 'note' ? 3 : 2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </Field>
      {bad && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {t('illness.badTemp')}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <Btn variant="primary" disabled={!ready} onClick={save}>
          {edit ? t('common.save') : t('illness.save')}
        </Btn>
        <Btn variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Btn>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ pantalla

/** Enfermedad: episodios con temperatura, síntomas, comida y pañales; la medicación dada durante el episodio y un informe para el pediatra. */
export function Illness() {
  const { ctx, baby, run, toast } = useApp();
  const babyId = baby?.id ?? '';
  const episodes = useLive(() => listEpisodes(ctx, babyId), [ctx, babyId], [] as IllnessEpisodeT[]);
  const entries = useLive(() => listEntries(ctx, babyId), [ctx, babyId], [] as IllnessEntryT[]);
  const medications = useLive(() => listMedications(ctx, babyId), [ctx, babyId], [] as MedicationT[]);
  const doses = useLive(() => listDoses(ctx, babyId), [ctx, babyId], [] as MedicationDoseT[]);
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const feedings = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const awakenings = useLive(() => listAwakenings(ctx, babyId), [ctx, babyId], [] as AwakeningT[]);
  const now = useNow(60_000);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [episodeSheet, setEpisodeSheet] = useState<{ edit: IllnessEpisodeT | null } | null>(null);
  const [entrySheet, setEntrySheet] = useState<{ kind: IllnessEntryKindT; edit: IllnessEntryT | null } | null>(null);
  const [showReport, setShowReport] = useState(false);

  const open = episodes.find((e) => e.end_utc === null) ?? null;
  const current = episodes.find((e) => e.id === pickedId) ?? open ?? episodes[0] ?? null;
  const mine = useMemo(() => (current === null ? [] : entries.filter((e) => e.episode_id === current.id)), [entries, current]);
  const thr = thresholdMs(baby ?? undefined);

  const report = useMemo(
    () =>
      baby === null || current === null || !showReport
        ? null
        : buildIllnessReport({ baby, episode: current, entries: mine, medications, doses, sessions, feedings, awakenings, awakeningThresholdMs: thr, zone: ctx.zone, nowMs: now }),
    [baby, current, showReport, mine, medications, doses, sessions, feedings, awakenings, thr, ctx.zone, now],
  );
  if (baby === null) return null;

  const label = (e: IllnessEpisodeT): string => e.title ?? t('illness.untitled', { date: fmtDate(parseInstant(e.start_utc), ctx.zone) });
  const rangeText = (e: IllnessEpisodeT): string => {
    const days = daysText(episodeDayCount(localDate(parseInstant(e.start_utc), ctx.zone), localDate(episodeEndMs(e, now), ctx.zone)));
    return e.end_utc === null
      ? t('illness.range', { from: whenText(parseInstant(e.start_utc), ctx.zone), days })
      : t('illness.rangeEnded', { from: whenText(parseInstant(e.start_utc), ctx.zone), to: whenText(parseInstant(e.end_utc), ctx.zone), days });
  };

  const medsDuring = useMemo(() => {
    if (current === null) return [] as Array<{ dose: MedicationDoseT; med: MedicationT }>;
    const from = parseInstant(current.start_utc);
    const to = episodeEndMs(current, now);
    const byId = new Map(medications.map((m) => [m.id, m]));
    return doses
      .filter((d) => byId.has(d.medication_id) && parseInstant(d.given_utc) >= from && parseInstant(d.given_utc) <= to)
      .sort((a, b) => b.given_utc.localeCompare(a.given_utc))
      .map((d) => ({ dose: d, med: byId.get(d.medication_id)! }));
  }, [current, doses, medications, now]);

  const temps = temperatureSeries(mine);
  const lastTemp = temps[temps.length - 1] ?? null;
  const newestFirst = [...mine].reverse();

  const remove = async (e: IllnessEntryT) => {
    if (await run(async () => (await deleteEntry(ctx, e.id), true))) {
      toast(t('illness.entryRemoved'), { label: t('home.undo'), run: () => void run(() => restoreEntry(ctx, e.id)) });
    }
  };
  const removeEpisode = async (e: IllnessEpisodeT) => {
    if (await run(async () => (await deleteEpisode(ctx, e.id), true))) {
      setPickedId(null);
      toast(t('illness.removed'), { label: t('home.undo'), run: () => void run(() => restoreEpisode(ctx, e.id)) });
    }
  };

  return (
    <div className="space-y-4">
      {open === null && (
        <Btn variant="primary" className="w-full" onClick={() => setEpisodeSheet({ edit: null })}>
          + {t('illness.start')}
        </Btn>
      )}

      {current === null ? (
        <Card>
          <p className="text-sm text-muted">{t('illness.none')}</p>
        </Card>
      ) : (
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{current.end_utc === null ? t('illness.current') : t('illness.viewing')}</p>
          <h3 className="text-lg font-bold">{label(current)}</h3>
          <p className="text-sm text-muted">{rangeText(current)}</p>
          {current.notes && <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{current.notes}</p>}
          <p className="mt-2 text-sm">
            {lastTemp === null
              ? t('illness.noTemp')
              : t('illness.lastTemp', { value: fmtTemp(lastTemp.dc), site: lastTemp.site === null ? '' : ` (${t(SITE_KEY[lastTemp.site as TempSiteT]).toLowerCase()})`, ago: fmtDur(Math.max(1, Math.round((now - lastTemp.atMs) / MIN)) * MIN) })}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label={t('illness.addTitle')}>
            {(['temperature', 'symptom', 'intake', 'diaper', 'note'] as const).map((k) => (
              <Btn key={k} className="min-h-12 justify-start px-3 text-left" onClick={() => setEntrySheet({ kind: k, edit: null })}>
                <span aria-hidden>{KIND_ICON[k]} </span>
                {t(KIND_KEY[k])}
              </Btn>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Btn className="min-h-12 px-3 text-sm" onClick={() => setShowReport((x) => !x)} aria-expanded={showReport}>
              {showReport ? t('illness.reportHide') : t('illness.report')}
            </Btn>
            {current.end_utc === null ? (
              <Btn className="min-h-12 px-3 text-sm" onClick={() => void run(async () => (await endEpisode(ctx, current.id), toast(t('illness.ended')), true))}>
                {t('illness.end')}
              </Btn>
            ) : (
              <Btn className="min-h-12 px-3 text-sm" onClick={() => void run(() => reopenEpisode(ctx, current.id))}>
                {t('illness.reopen')}
              </Btn>
            )}
            <Btn variant="ghost" className="min-h-12 px-3 text-sm" onClick={() => setEpisodeSheet({ edit: current })}>
              {t('common.edit')}
            </Btn>
            <Btn variant="danger" className="min-h-12 px-3 text-sm" onClick={() => void removeEpisode(current)}>
              {t('common.delete')}
            </Btn>
          </div>
        </Card>
      )}

      {report !== null && (
        <>
          <p className="text-sm text-muted">{t('illness.reportIntro')}</p>
          <ReportView rep={report} filenameBase="informe-episodio" nowMs={now} />
        </>
      )}

      {current !== null && (
        <Card title={t('illness.timeline')}>
          {newestFirst.length === 0 ? (
            <p className="text-sm text-muted">{t('illness.timelineEmpty')}</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {newestFirst.map((e, i) => {
                const at = parseInstant(e.at_utc);
                const day = dayLabel(at, e.at_tz);
                const prev = i > 0 ? dayLabel(parseInstant(newestFirst[i - 1]!.at_utc), newestFirst[i - 1]!.at_tz) : null;
                return (
                  <li key={e.id} className="py-2">
                    {day !== prev && <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{day}</p>}
                    <div className="flex items-baseline justify-between gap-2">
                      <span>
                        <span aria-hidden>{KIND_ICON[e.kind]} </span>
                        <span className="font-semibold">{entryText(e)}</span>
                      </span>
                      <span className="shrink-0 text-muted">{clockOf(at, e.at_tz)}</span>
                    </div>
                    {e.kind !== 'note' && e.note && <p className="text-muted">{e.note}</p>}
                    <div className="mt-1 flex gap-2">
                      <Btn variant="ghost" className="min-h-10 px-3 text-sm" onClick={() => setEntrySheet({ kind: e.kind, edit: e })}>
                        {t('common.edit')}
                      </Btn>
                      <Btn variant="danger" className="min-h-10 px-3 text-sm" onClick={() => void remove(e)}>
                        {t('common.delete')}
                      </Btn>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {current !== null && (
        <Card title={t('illness.meds')}>
          {medsDuring.length === 0 ? (
            <p className="text-sm text-muted">{t('illness.medsNone')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {medsDuring.map(({ dose, med }) => (
                <li key={dose.id} className="flex items-baseline justify-between gap-2">
                  <span>{t('illness.medLine', { name: med.name, dose: dose.dose_text ?? med.dose_text })}</span>
                  <span className="shrink-0 text-muted">{whenText(parseInstant(dose.given_utc), dose.given_tz)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">{t('illness.medsHint')}</p>
        </Card>
      )}

      {episodes.length > 1 && (
        <Card title={t('illness.past')}>
          <ul className="divide-y divide-line text-sm">
            {episodes.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-semibold">{label(e)}</span>
                  <span className="block text-muted">{rangeText(e)}</span>
                </span>
                {current?.id === e.id ? null : (
                  <Btn variant="ghost" className="min-h-10 shrink-0 px-3 text-sm" onClick={() => setPickedId(e.id)}>
                    {t('illness.pick')}
                  </Btn>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-xs text-muted">{t('illness.disclaimer')}</p>

      {episodeSheet && <EpisodeSheet babyId={baby.id} edit={episodeSheet.edit} onClose={() => setEpisodeSheet(null)} />}
      {entrySheet && current && <EntrySheet episode={current} kind={entrySheet.kind} edit={entrySheet.edit} onClose={() => setEntrySheet(null)} />}
    </div>
  );
}

const fmtDate = (ms: number, zone: string): string => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: zone }).format(new Date(ms));
