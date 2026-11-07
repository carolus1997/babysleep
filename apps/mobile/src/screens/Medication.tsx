import type { MedicationDoseT, MedicationT } from '@babysleep/contract';
import { checkBeforeDose, closeDoseIds, CLOSE_DOSE_MIN, dosesInLast24h, lastDose, nextDue, parseInstant, type DoseWarning } from '@babysleep/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app/AppContext';
import type { MedIntent } from '../domain/medIntent';
import {
  addDose,
  addMedication,
  deleteDose,
  deleteMedication,
  editDose,
  editMedication,
  listDoses,
  listMedications,
  restoreDose,
  restoreMedication,
  resumeMedication,
  stopMedication,
} from '../domain/medication';
import { localToMs } from '../domain/sleep';
import { t } from '../i18n/es';
import { fmtClock, fmtDur, toLocalInput } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Btn, Card, Chip, Field, inputCls, Sheet } from '../ui/primitives';
import { parseDecimal } from './Growth';
import { TimeField, timeReady, type Choice } from './TimeField';

const MIN = 60_000;

/** «hoy 08:05» o «vie 15 ene 08:05», en la zona en que se anotó. */
function whenText(iso: string, zone: string, nowMs: number): string {
  const ms = parseInstant(iso);
  const day = (x: number) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(x));
  const clock = fmtClock(ms, zone);
  if (day(ms) === day(nowMs)) return `${t('med.today')} ${clock}`;
  const d = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone }).format(new Date(ms)).replace(',', '');
  return `${d} ${clock}`;
}

const intervalText = (min: number): string => (min % 60 === 0 ? `${min / 60} h` : fmtDur(min * MIN));
const hoursField = (min: number | null): string => (min === null ? '' : String(min / 60).replace('.', ','));

function warningText(w: DoseWarning): string {
  if (w.kind === 'recent') {
    const ago = fmtDur(Math.max(1, w.minutesAgo) * MIN);
    return w.intervalMin === null ? t('med.warnRecent', { ago }) : t('med.warnRecentInterval', { ago, int: intervalText(w.intervalMin) });
  }
  return t('med.warnMax', { n: w.count, max: w.max });
}

// --------------------------------------------------------------- tratamiento

function MedicationSheet({ babyId, edit, onClose }: { babyId: string; edit: MedicationT | null; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const [name, setName] = useState(edit?.name ?? '');
  const [dose, setDose] = useState(edit?.dose_text ?? '');
  const [hours, setHours] = useState(hoursField(edit?.interval_min ?? null));
  const [dailyMax, setDailyMax] = useState(edit?.daily_max?.toString() ?? '');
  const [remind, setRemind] = useState(edit?.remind ?? true);
  const [start, setStart] = useState(edit ? toLocalInput(parseInstant(edit.start_utc), edit.start_tz) : toLocalInput(ctx.now(), ctx.zone));
  const [startChoice, setStartChoice] = useState<Choice>(undefined);
  const [hasEnd, setHasEnd] = useState(edit?.end_utc != null);
  const [end, setEnd] = useState(edit?.end_utc ? toLocalInput(parseInstant(edit.end_utc), edit.start_tz) : '');
  const [endChoice, setEndChoice] = useState<Choice>(undefined);
  const [notes, setNotes] = useState(edit?.notes ?? '');
  const [bad, setBad] = useState(false);
  const ready = name.trim() !== '' && dose.trim() !== '' && timeReady(start, ctx.zone, startChoice) && (!hasEnd || (end !== '' && timeReady(end, ctx.zone, endChoice)));

  const save = async () => {
    const h = parseDecimal(hours);
    const max = dailyMax.trim() === '' ? null : Number(dailyMax.trim());
    if ((h !== null && !Number.isFinite(h)) || (max !== null && !Number.isInteger(max))) return setBad(true);
    setBad(false);
    const intervalMin = h === null ? null : Math.round(h * 60);
    const ok = await run(async () => {
      const common = {
        name,
        doseText: dose,
        intervalMin,
        dailyMax: max,
        remind,
        notes,
        startLocal: start,
        ...(startChoice === undefined ? {} : { startChoice }),
        endLocal: hasEnd ? end : null,
        ...(endChoice === undefined ? {} : { endChoice }),
      };
      if (edit === null) await addMedication(ctx, { babyId, ...common });
      else await editMedication(ctx, edit.id, common);
      return true;
    });
    if (ok) {
      toast(t('med.saved'));
      onClose();
    }
  };

  return (
    <Sheet title={edit ? t('med.edit') : t('med.new')} onClose={onClose}>
      <Field label={t('med.name')}>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={t('med.namePlaceholder')} autoCapitalize="sentences" />
      </Field>
      <Field label={t('med.dose')}>
        <input className={inputCls} value={dose} onChange={(e) => setDose(e.target.value)} maxLength={160} />
      </Field>
      <p className="-mt-2 mb-3 text-xs text-muted">{t('med.doseHint')}</p>
      <Field label={t('med.interval')}>
        <input className={inputCls} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="6" />
      </Field>
      <p className="-mt-2 mb-3 text-xs text-muted">{t('med.intervalHint')}</p>
      <Field label={t('med.dailyMax')}>
        <input className={inputCls} inputMode="numeric" value={dailyMax} onChange={(e) => setDailyMax(e.target.value)} placeholder="4" />
      </Field>
      <p className="-mt-2 mb-3 text-xs text-muted">{t('med.dailyMaxHint')}</p>
      <TimeField label={t('med.start')} value={start} onChange={setStart} choice={startChoice} onChoice={setStartChoice} zone={ctx.zone} />
      <div className="mb-3">
        <Chip active={hasEnd} onClick={() => setHasEnd((x) => !x)}>
          {t('med.hasEnd')}
        </Chip>
      </div>
      {hasEnd && <TimeField label={t('med.end')} value={end} onChange={setEnd} choice={endChoice} onChoice={setEndChoice} zone={ctx.zone} />}
      <div className="mb-3">
        <Chip active={remind} onClick={() => setRemind((x) => !x)}>
          {t('med.remind')}
        </Chip>
        <p className="mt-1 text-xs text-muted">{t('med.remindHint')}</p>
      </div>
      <Field label={t('med.notes')}>
        <textarea className={`${inputCls} py-2`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      </Field>
      {bad && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {t('med.badNumber')}
        </p>
      )}
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

// --------------------------------------------------------------------- dosis

/** Anotar (o editar) una dosis. Antes de anotar enseña, como hechos, si ya hay una reciente o se alcanzó el máximo. */
function DoseSheet({ med, doses, edit, onClose }: { med: MedicationT; doses: readonly MedicationDoseT[]; edit: MedicationDoseT | null; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const initial = useMemo(() => toLocalInput(edit ? parseInstant(edit.given_utc) : ctx.now(), edit ? edit.given_tz : ctx.zone), [ctx, edit]);
  const [when, setWhen] = useState(initial);
  const [choice, setChoice] = useState<Choice>(undefined);
  const [given, setGiven] = useState(edit?.dose_text ?? '');
  const [notes, setNotes] = useState(edit?.notes ?? '');
  const ready = timeReady(when, ctx.zone, choice);

  /** Sin tocar la hora, es «ahora» exacto (con segundos); si se cambia, la hora escrita. */
  const atMs = (): number => {
    if (when === initial && !edit) return ctx.now();
    if (when === initial && edit) return parseInstant(edit.given_utc);
    return localToMs(when, ctx.zone, choice);
  };

  const warnings = useMemo<DoseWarning[]>(() => {
    if (edit !== null || !ready) return [];
    try {
      return checkBeforeDose(med, doses, atMs());
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [med, doses, when, choice, ready, edit]);

  const save = async () => {
    const ok = await run(async () => {
      if (edit === null) await addDose(ctx, { medicationId: med.id, atMs: atMs(), doseText: given, notes, confirmed: true });
      else await editDose(ctx, edit.id, { atMs: atMs(), doseText: given, notes });
      return true;
    });
    if (ok) {
      toast(t('med.doseSaved'));
      onClose();
    }
  };

  return (
    <Sheet title={edit ? t('med.doseEdit') : t('med.doseSheet', { name: med.name })} onClose={onClose}>
      {warnings.length > 0 && (
        <div role="alert" className="mb-3 rounded-2xl border border-line bg-surface2 p-3">
          <p className="font-semibold">{t('med.warnTitle')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {warnings.map((w) => (
              <li key={w.kind}>{warningText(w)}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">{t('med.warnHint')}</p>
        </div>
      )}
      <TimeField label={t('med.doseWhen')} value={when} onChange={setWhen} choice={choice} onChoice={setChoice} zone={ctx.zone} />
      <Field label={t('med.doseGiven')}>
        <input className={inputCls} value={given} onChange={(e) => setGiven(e.target.value)} maxLength={160} placeholder={med.dose_text} />
      </Field>
      <p className="-mt-2 mb-3 text-xs text-muted">{t('med.doseGivenHint', { dose: med.dose_text })}</p>
      <Field label={t('med.doseNotes')}>
        <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
      </Field>
      <div className="flex flex-col gap-2">
        <Btn variant="primary" disabled={!ready} onClick={save}>
          {edit ? t('common.save') : warnings.length > 0 ? t('med.registerAnyway') : t('med.register')}
        </Btn>
        <Btn variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Btn>
      </div>
    </Sheet>
  );
}

function MedicationCard({
  med,
  doses,
  who,
  nowMs,
  highlight,
  onGive,
  onEdit,
  onEditDose,
}: {
  med: MedicationT;
  doses: readonly MedicationDoseT[];
  who: (id: string | null) => string | null;
  nowMs: number;
  highlight: boolean;
  onGive: () => void;
  onEdit: () => void;
  onEditDose: (d: MedicationDoseT) => void;
}) {
  const { ctx, run, toast } = useApp();
  const [open, setOpen] = useState(false);
  const mine = useMemo(() => doses.filter((d) => d.medication_id === med.id), [doses, med.id]);
  // El reloj de la pantalla se refresca cada 30 s: una dosis recién anotada queda unos segundos «en el futuro». Se cuenta desde ella.
  const lastMs = mine.reduce((m, d) => Math.max(m, parseInstant(d.given_utc)), 0);
  const asOf = Math.max(nowMs, lastMs);
  const ended = med.end_utc !== null && parseInstant(med.end_utc) <= nowMs;
  const notStarted = parseInstant(med.start_utc) > nowMs;
  const due = nextDue(med, mine, asOf);
  const last = lastDose(mine);
  const n24 = dosesInLast24h(mine, asOf);
  const close = useMemo(() => closeDoseIds(mine), [mine]);

  const remove = async () => {
    if (await run(async () => (await deleteMedication(ctx, med.id), true))) {
      toast(t('med.removed'), { label: t('home.undo'), run: () => void run(() => restoreMedication(ctx, med.id)) });
    }
  };
  const removeDose = async (d: MedicationDoseT) => {
    if (await run(async () => (await deleteDose(ctx, d.id), true))) {
      toast(t('med.doseRemoved'), { label: t('home.undo'), run: () => void run(() => restoreDose(ctx, d.id)) });
    }
  };

  return (
    <Card className={`${ended ? 'opacity-80' : ''} ${highlight ? 'ring-2 ring-accent' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold">{med.name}</h3>
        <span className="shrink-0 text-xs font-semibold text-muted">{med.interval_min === null ? t('med.onDemand') : t('med.every', { dur: intervalText(med.interval_min) })}</span>
      </div>
      <p className="text-sm">{med.dose_text}</p>
      <p className="text-xs text-muted">
        {[med.daily_max !== null ? t('med.maxDay', { n: med.daily_max }) : null, med.interval_min !== null && !med.remind ? t('med.noReminder') : null].filter(Boolean).join(' · ')}
      </p>
      {med.notes && <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{med.notes}</p>}

      {ended ? (
        <p className="mt-2 text-sm text-muted">{t('med.endedOn', { when: whenText(med.end_utc!, med.start_tz, nowMs) })}</p>
      ) : notStarted ? (
        <p className="mt-2 text-sm text-muted">{t('med.notStarted', { when: whenText(med.start_utc, med.start_tz, nowMs) })}</p>
      ) : (
        due !== null && (
          <p className={`mt-2 text-base font-semibold ${due.minutesLeft <= 0 ? 'text-danger' : ''}`} aria-live="polite">
            {due.minutesLeft > 0
              ? t('med.nextIn', { dur: fmtDur(due.minutesLeft * MIN), at: fmtClock(due.dueMs, ctx.zone) })
              : due.minutesLeft === 0
                ? t('med.nextNow')
                : t('med.nextDue', { dur: fmtDur(-due.minutesLeft * MIN), at: fmtClock(due.dueMs, ctx.zone) })}
          </p>
        )
      )}
      <p className="mt-1 text-sm text-muted">
        {last === null
          ? t('med.none')
          : who(last.created_by) !== null
            ? t('med.lastBy', { when: whenText(last.given_utc, last.given_tz, nowMs), who: who(last.created_by)! })
            : t('med.last', { when: whenText(last.given_utc, last.given_tz, nowMs) })}
      </p>
      {mine.length > 0 && (
        <p className="text-xs text-muted">{med.daily_max !== null ? t('med.last24max', { n: n24, max: med.daily_max }) : t('med.last24', { n: n24 })}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!ended && (
          <Btn variant="primary" className="min-h-12 px-4" onClick={onGive}>
            {t('med.given')}
          </Btn>
        )}
        <Btn className="min-h-12 px-3 text-sm" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
          {open ? t('med.hideHistory') : t('med.history')}
        </Btn>
        {ended ? (
          <Btn className="min-h-12 px-3 text-sm" onClick={() => void run(() => resumeMedication(ctx, med.id))}>
            {t('med.resume')}
          </Btn>
        ) : (
          <Btn
            className="min-h-12 px-3 text-sm"
            onClick={() => void run(async () => (await stopMedication(ctx, med.id), toast(t('med.stopped')), true))}
          >
            {t('med.stop')}
          </Btn>
        )}
        <Btn variant="ghost" className="min-h-12 px-3 text-sm" onClick={onEdit}>
          {t('common.edit')}
        </Btn>
        <Btn variant="danger" className="min-h-12 px-3 text-sm" onClick={remove}>
          {t('common.delete')}
        </Btn>
      </div>

      {open && (
        <ul className="mt-3 divide-y divide-line text-sm">
          {[...mine].reverse().map((d) => (
            <li key={d.id} className="py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{whenText(d.given_utc, d.given_tz, nowMs)}</span>
                <span className="text-muted">{[d.dose_text, who(d.created_by)].filter(Boolean).join(' · ')}</span>
              </div>
              {d.notes && <p className="text-muted">{d.notes}</p>}
              {close.has(d.id) && <p className="text-xs text-danger">{t('med.closeFlag', { min: CLOSE_DOSE_MIN })}</p>}
              <div className="mt-1 flex gap-2">
                <Btn variant="ghost" className="min-h-10 px-3 text-sm" onClick={() => onEditDose(d)}>
                  {t('common.edit')}
                </Btn>
                <Btn variant="danger" className="min-h-10 px-3 text-sm" onClick={() => void removeDose(d)}>
                  {t('common.delete')}
                </Btn>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Medicación: tratamientos tal como los pautó el médico, con cuenta atrás, registro de dosis y avisos al móvil. */
export function Medication({ intent, onIntentUsed }: { intent: MedIntent | null; onIntentUsed: () => void }) {
  const { ctx, baby, toast } = useApp();
  const babyId = baby?.id ?? '';
  const meds = useLive(() => listMedications(ctx, babyId), [ctx, babyId], null as MedicationT[] | null);
  const doses = useLive(() => listDoses(ctx, babyId), [ctx, babyId], [] as MedicationDoseT[]);
  const caregivers = useLive(() => ctx.db.caregiver.toArray(), [ctx], [] as Array<{ id: string; display_name: string }>);
  const now = useNow(30_000);
  const [sheet, setSheet] = useState<{ edit: MedicationT | null } | null>(null);
  const [dose, setDose] = useState<{ med: MedicationT; edit: MedicationDoseT | null } | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const handled = useRef<string | null>(null);

  const who = (id: string | null): string | null => (id === null ? null : (caregivers.find((c) => c.id === id)?.display_name ?? null));

  // Un aviso (o su botón «Ya la di») abre la app en ese tratamiento. «Ya la di» solo abre la hoja: la persona confirma la hora.
  useEffect(() => {
    if (intent === null || meds === null) return;
    const key = `${intent.medicationId}:${intent.given}`;
    if (handled.current === key) return;
    handled.current = key;
    const m = meds.find((x) => x.id === intent.medicationId);
    if (m === undefined) toast(t('med.intentMissing'));
    else {
      setHighlight(m.id);
      if (intent.given) setDose({ med: m, edit: null });
    }
    onIntentUsed();
  }, [intent, meds, toast, onIntentUsed]);

  if (baby === null) return null;
  const list = meds ?? [];
  const ended = list.filter((m) => m.end_utc !== null && parseInstant(m.end_utc) <= now);
  const current = list.filter((m) => !ended.includes(m));
  const card = (m: MedicationT) => (
    <MedicationCard
      key={m.id}
      med={m}
      doses={doses}
      who={who}
      nowMs={now}
      highlight={highlight === m.id}
      onGive={() => setDose({ med: m, edit: null })}
      onEdit={() => setSheet({ edit: m })}
      onEditDose={(d) => setDose({ med: m, edit: d })}
    />
  );

  return (
    <div className="space-y-4">
      <Btn variant="primary" className="w-full" onClick={() => setSheet({ edit: null })}>
        + {t('med.new')}
      </Btn>

      {current.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">{t('med.empty')}</p>
        </Card>
      ) : (
        current.map(card)
      )}

      {ended.length > 0 && (
        <>
          <Btn variant="ghost" className="w-full" onClick={() => setShowEnded((x) => !x)} aria-expanded={showEnded}>
            {showEnded ? t('med.hideEnded') : t('med.showEnded', { n: ended.length })}
          </Btn>
          {showEnded && ended.map(card)}
        </>
      )}

      <Card title={t('med.how')}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>{t('med.how1')}</li>
          <li>{t('med.how2')}</li>
          <li>{t('med.how3')}</li>
        </ul>
      </Card>
      <p className="text-xs text-muted">{t('med.disclaimer')}</p>

      {sheet && <MedicationSheet babyId={baby.id} edit={sheet.edit} onClose={() => setSheet(null)} />}
      {dose && (
        <DoseSheet
          med={dose.med}
          doses={doses.filter((d) => d.medication_id === dose.med.id)}
          edit={dose.edit}
          onClose={() => setDose(null)}
        />
      )}
    </div>
  );
}

