import type { AppointmentT, GrowthMeasureT, MedicationDoseT, MedicationT, VaccinationT } from '@babysleep/contract';
import { localDate, nextMilestone, parseInstant } from '@babysleep/core';
import { useMemo } from 'react';
import { useApp } from '../app/AppContext';
import { listAppointments, upcoming } from '../domain/appointments';
import { listGrowth } from '../domain/growth';
import { listDoses, listMedications } from '../domain/medication';
import { listVaccinations, planFor } from '../domain/vaccines';
import { t } from '../i18n/es';
import { useLive, useNow } from '../ui/hooks';
import { Icon, type IconName } from '../ui/Icon';
import { Card } from '../ui/primitives';

export type HealthSection = 'vaccines' | 'appointments' | 'growth' | 'medication' | 'illness' | 'profile';

/** Una fila-resumen que abre su sección. */
function Row({ icon, title, value, hint, onClick }: { icon: IconName; title: string; value: string; hint?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex min-h-16 w-full items-center gap-3 rounded-2xl px-1 text-left transition-colors hover:bg-surface2">
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
        <Icon name={icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-bold text-muted">{title}</span>
        <span className="block text-base font-extrabold">{value}</span>
        {hint && <span className="block text-[13px] text-muted">{hint}</span>}
      </span>
      <Icon name="next" size={18} className="text-muted" />
    </button>
  );
}

/** Salud · Resumen: lo próximo y lo de hoy de un vistazo (solo lectura; cada fila abre su sección). */
export function HealthOverview({ onGo }: { onGo: (s: HealthSection) => void }) {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const now = useNow(60_000);
  const vacs = useLive(() => listVaccinations(ctx, babyId), [ctx, babyId], [] as VaccinationT[]);
  const appts = useLive(() => listAppointments(ctx, babyId), [ctx, babyId], [] as AppointmentT[]);
  const meds = useLive(() => listMedications(ctx, babyId), [ctx, babyId], [] as MedicationT[]);
  const doses = useLive(() => listDoses(ctx, babyId), [ctx, babyId], [] as MedicationDoseT[]);
  const growth = useLive(() => listGrowth(ctx, babyId), [ctx, babyId], [] as GrowthMeasureT[]);
  const plan = useMemo(() => (baby === null ? [] : planFor(ctx, baby, vacs)), [ctx, baby, vacs, now]);
  if (baby === null) return null;

  const next = nextMilestone(plan);
  const nextAppt = [...upcoming(appts, now)].sort((a, b) => a.start_utc.localeCompare(b.start_utc))[0];
  const activeMeds = meds.filter((m) => m.end_utc === null || parseInstant(m.end_utc) > now);
  const today = localDate(now, ctx.zone);
  const dosesToday = doses.filter((d) => localDate(parseInstant(d.given_utc), ctx.zone) === today && activeMeds.some((m) => m.id === d.medication_id)).length;
  const lastGrowth = [...growth].sort((a, b) => b.measured_on.localeCompare(a.measured_on))[0];
  const fmtWhen = (iso: string) =>
    new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: ctx.zone }).format(new Date(iso));

  return (
    <Card title={t('health.next')}>
      <div className="divide-y divide-line">
        <Row
          icon="vaccine"
          title={t('health.sec.vaccines')}
          value={next === null ? t('vac.allDone') : next.milestone.label}
          {...(next !== null ? { hint: next.daysToDue >= 0 ? t('vac.inDays', { n: next.daysToDue }) : t('vac.agoDays', { n: -next.daysToDue }) } : {})}
          onClick={() => onGo('vaccines')}
        />
        <Row
          icon="calendar"
          title={t('health.sec.appointments')}
          value={nextAppt ? nextAppt.title : t('health.noAppt')}
          {...(nextAppt ? { hint: fmtWhen(nextAppt.start_utc) } : {})}
          onClick={() => onGo('appointments')}
        />
        <Row
          icon="pill"
          title={t('health.sec.medication')}
          value={activeMeds.length === 0 ? t('health.noMeds') : t('health.medsActive', { n: activeMeds.length })}
          {...(activeMeds.length > 0 ? { hint: t('health.dosesToday', { n: dosesToday }) } : {})}
          onClick={() => onGo('medication')}
        />
        <Row
          icon="growth"
          title={t('health.sec.growth')}
          value={lastGrowth?.weight_g ? `${(lastGrowth.weight_g / 1000).toFixed(2).replace('.', ',')} kg` : t('health.noGrowth')}
          {...(lastGrowth ? { hint: lastGrowth.measured_on } : {})}
          onClick={() => onGo('growth')}
        />
      </div>
    </Card>
  );
}
