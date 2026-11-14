import type { VaccinationT } from '@babysleep/contract';
import { localDate, MADRID_2026, nextMilestone, type DoseStatus, type PlannedDose as CorePlannedDose, type PlannedMilestone as CorePlannedMilestone } from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import {
  addExtraVaccine,
  deleteVaccination,
  editVaccination,
  listVaccinations,
  markNotApplicable,
  planFor,
  recordDoses,
  restoreVaccination,
} from '../domain/vaccines';
import { t, type I18nKey } from '../i18n/es';
import { useLive, useNow } from '../ui/hooks';
import { Disclosure, ExpandBar, useOpenSet } from '../ui/Disclosure';
import { Btn, Card, Field, inputCls, Sheet } from '../ui/primitives';

type PlannedDose = CorePlannedDose<VaccinationT>;
type PlannedMilestone = CorePlannedMilestone<VaccinationT>;

const STATUS_KEY: Record<DoseStatus, I18nKey> = {
  given: 'vac.status.given',
  not_applicable: 'vac.status.na',
  later: 'vac.status.later',
  soon: 'vac.status.soon',
  unconfirmed: 'vac.status.unconfirmed',
};
const STATUS_CLS: Record<DoseStatus, string> = {
  given: 'text-ok',
  not_applicable: 'text-muted',
  later: 'text-muted',
  soon: 'text-accent',
  unconfirmed: 'text-danger',
};

/** `2027-01-05` → «5 ene 2027». */
const fmtDate = (d: string): string =>
  new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

function when(days: number): string {
  if (days === 0) return t('vac.today');
  return days > 0 ? t('vac.inDays', { n: days }) : t('vac.agoDays', { n: -days });
}

// ------------------------------------------------------------------ hojas

function RecordSheet({ babyId, milestone, only, onClose }: { babyId: string; milestone: PlannedMilestone; only?: PlannedDose; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const pending = (only ? [only] : milestone.doses).filter((d) => d.record === null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(pending.map((d) => d.key)));
  const [date, setDate] = useState(localDate(ctx.now(), ctx.zone));
  const [center, setCenter] = useState('');
  const [lot, setLot] = useState('');
  const toggle = (k: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const save = async () => {
    const made = await run(() => recordDoses(ctx, { babyId, doseKeys: [...picked], givenOn: date, center, lot }));
    if (made !== undefined) {
      toast(t('vac.recorded', { n: made.length }), {
        label: t('home.undo'),
        run: () => void run(async () => void (await Promise.all(made.map((v) => deleteVaccination(ctx, v.id))))),
      });
      onClose();
    }
  };
  return (
    <Sheet title={t('vac.recordTitle', { age: milestone.milestone.label })} onClose={onClose}>
      <ul className="mb-3 space-y-1">
        {pending.map((d) => (
          <li key={d.key}>
            <label className="flex min-h-11 items-center gap-3 rounded-xl px-1">
              <input type="checkbox" className="size-5" checked={picked.has(d.key)} onChange={() => toggle(d.key)} />
              <span>{d.label}</span>
            </label>
          </li>
        ))}
      </ul>
      <Field label={t('vac.date')}>
        <input type="date" className={inputCls} value={date} max={localDate(ctx.now(), ctx.zone)} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label={`${t('vac.center')} · ${t('feed.optional')}`}>
        <input className={inputCls} value={center} onChange={(e) => setCenter(e.target.value)} maxLength={160} />
      </Field>
      <Field label={`${t('vac.lot')} · ${t('feed.optional')}`}>
        <input className={inputCls} value={lot} onChange={(e) => setLot(e.target.value)} maxLength={60} autoComplete="off" />
      </Field>
      <div className="flex flex-col gap-2">
        <Btn variant="primary" disabled={picked.size === 0 || date === ''} onClick={save}>
          {t('common.save')}
        </Btn>
        <Btn variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Btn>
      </div>
    </Sheet>
  );
}

function DoseSheet({ babyId, milestone, dose, onClose, onRecord }: { babyId: string; milestone: PlannedMilestone | null; dose: PlannedDose; onClose: () => void; onRecord: () => void }) {
  const { ctx, run, toast } = useApp();
  const rec = dose.record;
  const [date, setDate] = useState(rec?.given_on ?? '');
  const [center, setCenter] = useState(rec?.center ?? '');
  const [lot, setLot] = useState(rec?.lot ?? '');
  const [notes, setNotes] = useState(rec?.notes ?? '');
  const remove = async () => {
    if (rec === null) return;
    if (await run(async () => (await deleteVaccination(ctx, rec.id), true))) {
      toast(t('vac.removed'), { label: t('home.undo'), run: () => void run(() => restoreVaccination(ctx, rec.id)) });
      onClose();
    }
  };
  const save = async () => {
    if (rec === null) return;
    const patch: Parameters<typeof editVaccination>[2] = { center, lot, notes };
    if (rec.status === 'given' && date !== rec.given_on) patch.givenOn = date;
    if (await run(async () => (await editVaccination(ctx, rec.id, patch), true))) onClose();
  };
  return (
    <Sheet title={milestone === null ? dose.label : `${dose.label} · ${milestone.milestone.label}`} onClose={onClose}>
      {rec === null ? (milestone === null ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">
            {t('vac.dueOn', { date: fmtDate(milestone.dueDate) })} · {t(STATUS_KEY[dose.status])}
          </p>
          <Btn variant="primary" onClick={onRecord}>
            {t('vac.markGiven')}
          </Btn>
          <Btn
            onClick={async () => {
              if (await run(async () => (await markNotApplicable(ctx, babyId, dose.key), true))) onClose();
            }}
          >
            {t('vac.markNa')}
          </Btn>
          <p className="text-xs text-muted">{t('vac.naHint')}</p>
        </div>
      )) : (
        <>
          {rec.status === 'given' ? (
            <Field label={t('vac.date')}>
              <input type="date" className={inputCls} value={date} max={localDate(ctx.now(), ctx.zone)} onChange={(e) => setDate(e.target.value)} />
            </Field>
          ) : (
            <p className="mb-3 text-sm text-muted">{t('vac.status.na')}</p>
          )}
          <Field label={t('vac.center')}>
            <input className={inputCls} value={center} onChange={(e) => setCenter(e.target.value)} maxLength={160} />
          </Field>
          <Field label={t('vac.lot')}>
            <input className={inputCls} value={lot} onChange={(e) => setLot(e.target.value)} maxLength={60} autoComplete="off" />
          </Field>
          <Field label={t('vac.notes')}>
            <textarea className={`${inputCls} py-2`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          </Field>
          <div className="flex flex-col gap-2">
            <Btn variant="primary" onClick={save}>
              {t('common.save')}
            </Btn>
            <Btn variant="danger" onClick={remove}>
              {t('vac.remove')}
            </Btn>
          </div>
        </>
      )}
    </Sheet>
  );
}

function ExtraSheet({ babyId, onClose }: { babyId: string; onClose: () => void }) {
  const { ctx, run } = useApp();
  const [name, setName] = useState('');
  const [date, setDate] = useState(localDate(ctx.now(), ctx.zone));
  const [center, setCenter] = useState('');
  const [lot, setLot] = useState('');
  const save = async () => {
    if (await run(async () => (await addExtraVaccine(ctx, { babyId, vaccine: name, givenOn: date, center, lot }), true))) onClose();
  };
  return (
    <Sheet title={t('vac.extraTitle')} onClose={onClose}>
      <Field label={t('vac.extraName')}>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={t('vac.extraPlaceholder')} />
      </Field>
      <Field label={t('vac.date')}>
        <input type="date" className={inputCls} value={date} max={localDate(ctx.now(), ctx.zone)} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label={`${t('vac.center')} · ${t('feed.optional')}`}>
        <input className={inputCls} value={center} onChange={(e) => setCenter(e.target.value)} maxLength={160} />
      </Field>
      <Field label={`${t('vac.lot')} · ${t('feed.optional')}`}>
        <input className={inputCls} value={lot} onChange={(e) => setLot(e.target.value)} maxLength={60} autoComplete="off" />
      </Field>
      <div className="flex flex-col gap-2">
        <Btn variant="primary" disabled={name.trim() === '' || date === ''} onClick={save}>
          {t('common.save')}
        </Btn>
        <Btn variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Btn>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ pantalla

/** Calendario de vacunación de la Comunidad de Madrid: lo previsto, lo registrado y lo que falta por confirmar. */
export function Vaccines({ onSchedule }: { onSchedule?: (m: PlannedMilestone) => void }) {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const records = useLive(() => listVaccinations(ctx, babyId), [ctx, babyId], [] as VaccinationT[]);
  const now = useNow(300_000);
  const [record, setRecord] = useState<{ milestone: PlannedMilestone; only?: PlannedDose } | null>(null);
  const [dose, setDose] = useState<{ milestone: PlannedMilestone | null; dose: PlannedDose } | null>(null);
  const [extra, setExtra] = useState(false);
  // Todo cerrado por defecto: la próxima vacuna ya está arriba en «Lo siguiente», con sus botones.
  const open = useOpenSet();

  const plan = useMemo(() => (baby === null ? [] : planFor(ctx, baby, records)), [ctx, baby, records, now]);
  if (baby === null) return null;
  const allIds = [...plan.map((m) => m.milestone.id), 'seasonal', 'extra'];
  const next = nextMilestone(plan);
  const extras = records.filter((r) => r.dose_key === null);

  return (
    <div className="space-y-4">
      <Card title={t('vac.next')}>
        {next === null ? (
          <p className="text-sm text-muted">{t('vac.allDone')}</p>
        ) : (
          <>
            <p className="text-xl font-bold">{next.milestone.label}</p>
            <p className="text-sm text-muted">
              {t('vac.dueOn', { date: fmtDate(next.dueDate) })} · {when(next.daysToDue)}
            </p>
            <p className={`mt-1 text-sm font-semibold ${STATUS_CLS[next.status]}`}>{t(STATUS_KEY[next.status])}</p>
            {next.status === 'unconfirmed' && <p className="mt-1 text-xs text-muted">{t('vac.unconfirmedHint')}</p>}
            <Btn variant="primary" className="mt-3 w-full" onClick={() => setRecord({ milestone: next })}>
              {t('vac.record')}
            </Btn>
            {onSchedule && (
              <Btn className="mt-2 w-full" onClick={() => onSchedule(next)}>
                {t('vac.schedule')}
              </Btn>
            )}
          </>
        )}
      </Card>

      <ExpandBar label={t('vac.byAge')} anyOpen={open.anyOpen(allIds)} onExpand={() => open.openAll(allIds)} onCollapse={open.closeAll} />

      <div className="space-y-2.5">
      {plan.map((m) => (
        <Disclosure
          key={m.milestone.id}
          title={m.milestone.label}
          summary={`${t('vac.dueOn', { date: fmtDate(m.dueDate) })} · ${when(m.daysToDue)}`}
          badge={<span className={STATUS_CLS[m.status]}>{t(STATUS_KEY[m.status])}</span>}
          open={open.isOpen(m.milestone.id)}
          onToggle={() => open.toggle(m.milestone.id)}
        >
          <ul className="divide-y divide-line">
            {m.doses.map((d) => (
              <li key={d.key}>
                <button className="flex min-h-12 w-full items-center justify-between gap-2 py-2 text-left" onClick={() => setDose({ milestone: m, dose: d })}>
                  <span>
                    <span className="block text-sm">{d.label}</span>
                    {d.record?.given_on && <span className="block text-xs text-muted">{fmtDate(d.record.given_on)}</span>}
                  </span>
                  <span className={`shrink-0 text-xs font-semibold ${STATUS_CLS[d.status]}`}>{t(STATUS_KEY[d.status])}</span>
                </button>
              </li>
            ))}
          </ul>
          {m.milestone.notes.map((n) => (
            <p key={n} className="mt-2 text-xs text-muted">
              {n}
            </p>
          ))}
          {m.doses.some((d) => d.record === null) && (
            <Btn className="mt-3 w-full" onClick={() => setRecord({ milestone: m })}>
              {t('vac.recordVisit')}
            </Btn>
          )}
        </Disclosure>
      ))}

      <Disclosure
        title={t('vac.seasonal')}
        summary={t('vac.seasonalCount', { n: MADRID_2026.seasonal.length })}
        open={open.isOpen('seasonal')}
        onToggle={() => open.toggle('seasonal')}
      >
        <ul className="space-y-2 pt-1 text-sm">
          {MADRID_2026.seasonal.map((s) => (
            <li key={s.id}>
              <span className="font-semibold">{s.label}</span>
              <span className="block text-xs text-muted">{s.note}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">{t('vac.seasonalHint')}</p>
      </Disclosure>

      <Disclosure
        title={t('vac.extra')}
        summary={extras.length === 0 ? t('vac.extraSummary') : t('vac.extraCount', { n: extras.length })}
        open={open.isOpen('extra')}
        onToggle={() => open.toggle('extra')}
      >
        {extras.length === 0 ? (
          <p className="text-sm text-muted">{t('vac.extraEmpty')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {extras.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span>
                  {r.vaccine}
                  {r.given_on && <span className="block text-xs text-muted">{fmtDate(r.given_on)}</span>}
                </span>
                <Btn
                  variant="ghost"
                  className="min-h-10 px-2 text-sm"
                  onClick={() => setDose({ milestone: null, dose: { key: r.id, antigen: r.vaccine, label: r.vaccine, status: 'given', record: r } })}
                >
                  {t('common.edit')}
                </Btn>
              </li>
            ))}
          </ul>
        )}
        <Btn className="mt-3 w-full" onClick={() => setExtra(true)}>
          + {t('vac.extraAdd')}
        </Btn>
      </Disclosure>
      </div>

      <p className="text-xs text-muted">
        {t('vac.source', { edition: MADRID_2026.edition })}{' '}
        <a className="underline" href={MADRID_2026.sourceUrl} target="_blank" rel="noreferrer">
          {t('vac.sourceLink')}
        </a>
      </p>
      <p className="text-xs text-muted">{t('vac.disclaimer')}</p>

      {record && <RecordSheet babyId={baby.id} milestone={record.milestone} {...(record.only ? { only: record.only } : {})} onClose={() => setRecord(null)} />}
      {dose && (
        <DoseSheet
          babyId={baby.id}
          milestone={dose.milestone}
          dose={dose.dose}
          onClose={() => setDose(null)}
          onRecord={() => {
            if (dose.milestone !== null) setRecord({ milestone: dose.milestone, only: dose.dose });
            setDose(null);
          }}
        />
      )}
      {extra && <ExtraSheet babyId={baby.id} onClose={() => setExtra(false)} />}
    </div>
  );
}
