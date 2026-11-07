import type { AppointmentKindT, AppointmentT } from '@babysleep/contract';
import { googleCalendarUrl, parseInstant, type CalendarEventInput } from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import {
  addAppointment,
  APPOINTMENT_KINDS,
  DEFAULT_REMINDERS,
  deleteAppointment,
  editAppointment,
  listAppointments,
  past,
  REMINDER_PRESETS,
  restoreAppointment,
  setAppointmentStatus,
  upcoming,
} from '../domain/appointments';
import { localToMs } from '../domain/sleep';
import { t, type I18nKey } from '../i18n/es';
import { shareOrDownloadIcs } from '../ui/calendar';
import { fmtDur, toLocalInput } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Btn, Card, Chip, Field, inputCls, Sheet } from '../ui/primitives';
import { TimeField, timeReady, type Choice } from './TimeField';

/** Una cita que se propone desde otra pantalla (p. ej. «poner cita» para las vacunas de un hito). */
export interface AppointmentDraft {
  kind: AppointmentKindT;
  title: string;
  /** Hora local sugerida (`YYYY-MM-DDTHH:mm`). */
  startLocal: string;
}

const KIND_KEY: Record<AppointmentKindT, I18nKey> = {
  pediatrician: 'appt.kind.pediatrician',
  nurse: 'appt.kind.nurse',
  vaccination: 'appt.kind.vaccination',
  specialist: 'appt.kind.specialist',
  test: 'appt.kind.test',
  other: 'appt.kind.other',
};

export function reminderLabel(min: number): string {
  if (min === 0) return t('appt.remind.atTime');
  if (min === 10080) return t('appt.remind.week');
  if (min === 1440) return t('appt.remind.day');
  if (min < 60) return t('appt.remind.before', { dur: `${min} min` });
  if (min % 60 === 0) return t('appt.remind.before', { dur: `${min / 60} h` });
  return t('appt.remind.before', { dur: fmtDur(min * 60_000) });
}

const fmtWhen = (iso: string, zone: string): string =>
  new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone })
    .format(new Date(iso))
    .replace(',', '');

const toEvent = (a: AppointmentT, babyAlias: string): CalendarEventInput => ({
  id: a.id,
  title: `${a.title} · ${babyAlias}`,
  start_utc: a.start_utc,
  duration_min: a.duration_min,
  place: a.place,
  notes: a.notes,
  status: a.status,
  remind_before_min: a.remind_before_min,
});

function AppointmentSheet({ babyId, edit, draft, onClose }: { babyId: string; edit: AppointmentT | null; draft: AppointmentDraft | null; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const [kind, setKind] = useState<AppointmentKindT>(edit?.kind ?? draft?.kind ?? 'pediatrician');
  const [title, setTitle] = useState(edit?.title ?? draft?.title ?? '');
  const [start, setStart] = useState(edit ? toLocalInput(parseInstant(edit.start_utc), edit.start_tz) : (draft?.startLocal ?? ''));
  const [choice, setChoice] = useState<Choice>(undefined);
  const [duration, setDuration] = useState(edit?.duration_min?.toString() ?? '');
  const [place, setPlace] = useState(edit?.place ?? '');
  const [notes, setNotes] = useState(edit?.notes ?? '');
  const [reminders, setReminders] = useState<number[]>(edit ? [...edit.remind_before_min] : [...DEFAULT_REMINDERS]);
  const toggle = (m: number) => setReminders((r) => (r.includes(m) ? r.filter((x) => x !== m) : [...r, m]));
  const ready = title.trim() !== '' && start !== '' && timeReady(start, ctx.zone, choice);

  const save = async () => {
    const dur = duration.trim() === '' ? null : Number(duration.trim());
    const ok = await run(async () => {
      if (edit === null) {
        await addAppointment(ctx, { babyId, kind, title, startLocal: start, ...(choice === undefined ? {} : { startChoice: choice }), durationMin: dur, place, notes, remindBeforeMin: reminders });
      } else {
        await editAppointment(ctx, edit.id, { kind, title, startLocal: start, ...(choice === undefined ? {} : { startChoice: choice }), durationMin: dur, place, notes, remindBeforeMin: reminders });
      }
      return true;
    });
    if (ok) {
      toast(t('appt.saved'));
      onClose();
    }
  };

  return (
    <Sheet title={edit ? t('appt.edit') : t('appt.new')} onClose={onClose}>
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t('appt.kind')}>
        {APPOINTMENT_KINDS.map((k) => (
          <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
            {t(KIND_KEY[k])}
          </Chip>
        ))}
      </div>
      <Field label={t('appt.title')}>
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder={t(KIND_KEY[kind])} />
      </Field>
      <TimeField label={t('appt.when')} value={start} onChange={setStart} choice={choice} onChoice={setChoice} zone={ctx.zone} />
      <Field label={`${t('appt.duration')} · ${t('feed.optional')}`}>
        <input className={inputCls} inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="30" />
      </Field>
      <Field label={`${t('appt.place')} · ${t('feed.optional')}`}>
        <input className={inputCls} value={place} onChange={(e) => setPlace(e.target.value)} maxLength={240} />
      </Field>
      <Field label={`${t('appt.notes')} · ${t('feed.optional')}`}>
        <textarea className={`${inputCls} py-2`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </Field>
      <div className="mb-3" role="group" aria-label={t('appt.reminders')}>
        <span className="mb-1 block text-sm font-medium text-muted">{t('appt.reminders')}</span>
        <div className="flex flex-wrap gap-2">
          {REMINDER_PRESETS.map((m) => (
            <Chip key={m} active={reminders.includes(m)} onClick={() => toggle(m)}>
              {reminderLabel(m)}
            </Chip>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">{t('appt.remindersHint')}</p>
      </div>
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

function AppointmentCard({ a, alias, onEdit, dim = false }: { a: AppointmentT; alias: string; onEdit: () => void; dim?: boolean }) {
  const { ctx, run, toast } = useApp();
  const event = toEvent(a, alias);
  const calendar = async () => {
    const r = await shareOrDownloadIcs(event, ctx.now(), a.title);
    if (r === 'downloaded') toast(t('appt.icsDownloaded'));
  };
  const remove = async () => {
    if (await run(async () => (await deleteAppointment(ctx, a.id), true))) {
      toast(t('appt.removed'), { label: t('home.undo'), run: () => void run(() => restoreAppointment(ctx, a.id)) });
    }
  };
  const setStatus = (s: 'scheduled' | 'done' | 'cancelled') => void run(() => setAppointmentStatus(ctx, a.id, s));
  return (
    <Card className={dim ? 'opacity-80' : ''}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold">{a.title}</h3>
        <span className="shrink-0 text-xs font-semibold text-muted">
          {a.status === 'done' ? t('appt.status.done') : a.status === 'cancelled' ? t('appt.status.cancelled') : t(KIND_KEY[a.kind])}
        </span>
      </div>
      <p className="text-sm">{fmtWhen(a.start_utc, a.start_tz)}</p>
      {a.place && <p className="text-sm text-muted">{a.place}</p>}
      {a.notes && <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{a.notes}</p>}
      {a.remind_before_min.length > 0 && a.status === 'scheduled' && (
        <p className="mt-1 text-xs text-muted">{t('appt.remindList', { list: a.remind_before_min.map(reminderLabel).join(' · ') })}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Btn className="min-h-10 px-3 text-sm" onClick={calendar}>
          {t('appt.toCalendar')}
        </Btn>
        <a
          className="inline-flex min-h-10 items-center rounded-2xl border border-line bg-surface2 px-3 text-sm font-semibold"
          href={googleCalendarUrl(event)}
          target="_blank"
          rel="noreferrer"
        >
          {t('appt.google')}
        </a>
        {a.status === 'scheduled' ? (
          <>
            <Btn className="min-h-10 px-3 text-sm" onClick={() => setStatus('done')}>
              {t('appt.markDone')}
            </Btn>
            <Btn className="min-h-10 px-3 text-sm" onClick={() => setStatus('cancelled')}>
              {t('appt.cancel')}
            </Btn>
          </>
        ) : (
          <Btn className="min-h-10 px-3 text-sm" onClick={() => setStatus('scheduled')}>
            {t('appt.reopen')}
          </Btn>
        )}
        <Btn variant="ghost" className="min-h-10 px-3 text-sm" onClick={onEdit}>
          {t('common.edit')}
        </Btn>
        <Btn variant="danger" className="min-h-10 px-3 text-sm" onClick={remove}>
          {t('common.delete')}
        </Btn>
      </div>
    </Card>
  );
}

/** Citas médicas: próximas, con avisos por notificación y paso al calendario del móvil o de Google. */
export function Appointments({ draft, onDraftUsed }: { draft: AppointmentDraft | null; onDraftUsed: () => void }) {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const all = useLive(() => listAppointments(ctx, babyId), [ctx, babyId], [] as AppointmentT[]);
  const now = useNow(60_000);
  const [sheet, setSheet] = useState<{ edit: AppointmentT | null; draft: AppointmentDraft | null } | null>(draft ? { edit: null, draft } : null);
  const [showPast, setShowPast] = useState(false);
  const next = useMemo(() => upcoming(all, now), [all, now]);
  const old = useMemo(() => past(all, now), [all, now]);
  if (baby === null) return null;
  const close = () => {
    setSheet(null);
    onDraftUsed();
  };

  return (
    <div className="space-y-4">
      <Btn variant="primary" className="w-full" onClick={() => setSheet({ edit: null, draft: null })}>
        + {t('appt.new')}
      </Btn>

      {next.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">{t('appt.empty')}</p>
        </Card>
      ) : (
        next.map((a) => <AppointmentCard key={a.id} a={a} alias={baby.alias} onEdit={() => setSheet({ edit: a, draft: null })} />)
      )}

      {old.length > 0 && (
        <>
          <Btn variant="ghost" className="w-full" onClick={() => setShowPast((x) => !x)} aria-expanded={showPast}>
            {showPast ? t('appt.hidePast') : t('appt.showPast', { n: old.length })}
          </Btn>
          {showPast && old.map((a) => <AppointmentCard key={a.id} a={a} alias={baby.alias} dim onEdit={() => setSheet({ edit: a, draft: null })} />)}
        </>
      )}

      <Card title={t('appt.how')}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>{t('appt.how1')}</li>
          <li>{t('appt.how2')}</li>
          <li>{t('appt.how3')}</li>
        </ul>
      </Card>
      <p className="text-xs text-muted">{t('appt.disclaimer')}</p>

      {sheet && <AppointmentSheet babyId={baby.id} edit={sheet.edit} draft={sheet.draft} onClose={close} />}
    </div>
  );
}

/** Hora local sugerida a las 09:00 de una fecha (`YYYY-MM-DD`); si ya pasó, mañana a esa hora. */
export function suggestStart(dateIso: string, ctx: { now(): number; zone: string }): string {
  const candidate = `${dateIso}T09:00`;
  try {
    if (localToMs(candidate, ctx.zone, 0) > ctx.now()) return candidate;
  } catch {
    /* hora inexistente o ambigua: se usa la de mañana */
  }
  const tomorrow = new Date(ctx.now() + 86_400_000);
  return `${toLocalInput(tomorrow.getTime(), ctx.zone).slice(0, 10)}T09:00`;
}
