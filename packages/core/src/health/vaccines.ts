import { DateTime } from 'luxon';

/**
 * Calendario de vacunación infantil de la Comunidad de Madrid, como DATO versionado.
 *
 * Fuente: «Calendario de vacunación/inmunización a lo largo de toda la vida 2026» (Dirección General de Salud
 * Pública, Consejería de Sanidad, edición de febrero de 2026), leído de la tabla oficial. Es una ayuda para no
 * olvidar fechas, NO una instrucción médica: la fuente de verdad es el Documento de Salud Infantil y el pediatra.
 * Cuando Madrid publique otra edición se añade otra constante; las vacunas ya registradas no se tocan, porque se
 * identifican por `dose_key` (`ANTÍGENO@hito`) y no por la edición.
 */
export interface VaccineDose {
  /** Identificador estable de la dosis: `ANTÍGENO@hito`. Es lo que se guarda en cada registro. */
  key: string;
  antigen: string;
  label: string;
}

export interface VaccineMilestone {
  /** Hito: `2m`, `4m`, `11m`… */
  id: string;
  /** Edad prevista en meses (de edad CRONOLÓGICA, también en prematuros). */
  dueMonths: number;
  label: string;
  doses: VaccineDose[];
  /** Aclaraciones del calendario oficial para este hito. */
  notes: string[];
}

export interface VaccineCalendar {
  region: string;
  edition: string;
  source: string;
  sourceUrl: string;
  milestones: VaccineMilestone[];
  /** Inmunizaciones estacionales o por campaña: se muestran como información, no se marcan como retrasadas. */
  seasonal: Array<{ id: string; label: string; note: string }>;
}

const d = (antigen: string, milestone: string, label: string): VaccineDose => ({ key: `${antigen}@${milestone}`, antigen, label });

export const MADRID_2026: VaccineCalendar = {
  region: 'Comunidad de Madrid',
  edition: '2026',
  source: 'Calendario de vacunación/inmunización a lo largo de toda la vida 2026 (Dirección General de Salud Pública, febrero 2026)',
  sourceUrl: 'https://www.comunidad.madrid/servicios/salud/vacunas-informacion-profesionales',
  milestones: [
    {
      id: '2m',
      dueMonths: 2,
      label: '2 meses',
      doses: [
        d('VHB', '2m', 'Hepatitis B'),
        d('DTPa', '2m', 'Difteria-tétanos-tosferina (DTPa)'),
        d('VPI', '2m', 'Poliomielitis (VPI)'),
        d('Hib', '2m', 'Haemophilus influenzae b (Hib)'),
        d('VNC', '2m', 'Neumococo (VNC)'),
        d('MenB', '2m', 'Meningococo B'),
        d('RV', '2m', 'Rotavirus'),
      ],
      notes: ['Meningococo B: sistemática para los nacidos a partir del 1 de noviembre de 2022.'],
    },
    {
      id: '4m',
      dueMonths: 4,
      label: '4 meses',
      doses: [
        d('VHB', '4m', 'Hepatitis B'),
        d('DTPa', '4m', 'Difteria-tétanos-tosferina (DTPa)'),
        d('VPI', '4m', 'Poliomielitis (VPI)'),
        d('Hib', '4m', 'Haemophilus influenzae b (Hib)'),
        d('VNC', '4m', 'Neumococo (VNC)'),
        d('MenB', '4m', 'Meningococo B'),
        d('MenC', '4m', 'Meningococo C'),
        d('RV', '4m', 'Rotavirus'),
      ],
      notes: [],
    },
    {
      id: '11m',
      dueMonths: 11,
      label: '11 meses',
      doses: [
        d('VHB', '11m', 'Hepatitis B'),
        d('DTPa', '11m', 'Difteria-tétanos-tosferina (DTPa)'),
        d('VPI', '11m', 'Poliomielitis (VPI)'),
        d('Hib', '11m', 'Haemophilus influenzae b (Hib)'),
        d('VNC', '11m', 'Neumococo (VNC)'),
      ],
      notes: [],
    },
    {
      id: '12m',
      dueMonths: 12,
      label: '12 meses',
      doses: [
        d('TV', '12m', 'Triple vírica (sarampión-rubéola-parotiditis)'),
        d('MenB', '12m', 'Meningococo B'),
        d('MenACWY', '12m', 'Meningococo ACWY'),
      ],
      notes: ['Desde el 1 de enero de 2026 la dosis de MenC de los 12 meses se sustituye por MenACWY.'],
    },
    { id: '15m', dueMonths: 15, label: '15 meses', doses: [d('VVZ', '15m', 'Varicela')], notes: [] },
    {
      id: '3a',
      dueMonths: 36,
      label: '3-4 años',
      doses: [d('SRPV', '3a', 'Tetravírica (sarampión-rubéola-parotiditis-varicela)')],
      notes: ['El calendario oficial la sitúa entre los 3 y los 4 años; aquí se prevé a los 3.'],
    },
    { id: '6a', dueMonths: 72, label: '6 años', doses: [d('DTPa-VPI', '6a', 'Difteria-tétanos-tosferina y polio (DTPa-VPI)')], notes: [] },
    {
      id: '12a',
      dueMonths: 144,
      label: '12 años',
      doses: [d('MenACWY', '12a', 'Meningococo ACWY'), d('VPH', '12a', 'Virus del papiloma humano (VPH)')],
      notes: [],
    },
    { id: '14a', dueMonths: 168, label: '14 años', doses: [d('dTpa', '14a', 'Difteria-tétanos-tosferina (dTpa, baja carga)')], notes: [] },
  ],
  seasonal: [
    {
      id: 'AcVRS',
      label: 'Virus respiratorio sincitial (anticuerpo)',
      note: 'Campaña estacional para lactantes: se administra en el hospital antes del alta o por autocita; depende de la fecha de nacimiento y de la temporada.',
    },
    { id: 'Gripe', label: 'Gripe anual', note: 'Recomendada de los 6 a los 59 meses, cada temporada.' },
    { id: 'COVID', label: 'COVID-19', note: 'Las recomendaciones se definen al inicio de cada temporada.' },
  ],
};

// ------------------------------------------------------------------ cálculo de fechas y estado

/** Un registro de vacuna tal como lo necesita el cálculo. */
export interface VaccineRecordInput {
  id: string;
  dose_key: string | null;
  status: 'given' | 'not_applicable';
  given_on: string | null;
  deleted_at?: string | null;
}

export type DoseStatus =
  /** Consta que se puso (con fecha). */
  | 'given'
  /** Se marcó «no procede». */
  | 'not_applicable'
  /** Falta más de `SOON_DAYS` para su fecha prevista. */
  | 'later'
  /** Su fecha prevista está a menos de `SOON_DAYS` (o acaba de pasar, dentro de `GRACE_DAYS`). */
  | 'soon'
  /** Pasó la fecha prevista y no consta que se pusiera: puede faltar el registro, no significa que no se pusiera. */
  | 'unconfirmed';

export const SOON_DAYS = 30;
export const GRACE_DAYS = 30;

export interface PlannedDose<R extends VaccineRecordInput = VaccineRecordInput> extends VaccineDose {
  status: DoseStatus;
  record: R | null;
}

export interface PlannedMilestone<R extends VaccineRecordInput = VaccineRecordInput> {
  milestone: VaccineMilestone;
  /** Fecha prevista (`YYYY-MM-DD`): nacimiento + `dueMonths` meses. */
  dueDate: string;
  doses: Array<PlannedDose<R>>;
  /** Estado global del hito: el más urgente de sus dosis pendientes, o `given`/`not_applicable` si no queda nada. */
  status: DoseStatus;
  /** Días hasta la fecha prevista (negativo si ya pasó). */
  daysToDue: number;
}

const DAY_MS = 86_400_000;
const utcDay = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** Suma meses de calendario a una fecha civil, recortando al último día del mes (31 ene + 1 mes = 28/29 feb). */
export function addMonths(date: string, months: number): string {
  const r = DateTime.fromISO(date, { zone: 'utc' }).plus({ months }).toISODate();
  if (r === null) throw new RangeError(`Fecha no válida: ${date}`);
  return r;
}

const RANK: Record<DoseStatus, number> = { unconfirmed: 0, soon: 1, later: 2, not_applicable: 3, given: 4 };

/** Estado de una dosis sin registro, según lo que falta para su fecha prevista. */
export function pendingStatus(dueDate: string, today: string): DoseStatus {
  const days = Math.round((utcDay(dueDate) - utcDay(today)) / DAY_MS);
  if (days > SOON_DAYS) return 'later';
  if (days >= -GRACE_DAYS) return 'soon';
  return 'unconfirmed';
}

/**
 * Plan de vacunación de un bebé: cada hito con su fecha prevista y el estado de cada dosis. La fecha prevista se
 * cuenta SIEMPRE desde el nacimiento (edad cronológica): las vacunas no se retrasan por prematuridad. Un registro
 * eliminado no cuenta. Con varios registros de la misma dosis gana el más reciente puesto (hay duplicados si dos
 * cuidadores anotaron la misma).
 */
export function vaccinePlan<R extends VaccineRecordInput = VaccineRecordInput>(
  input: { birthDate: string; records: readonly R[]; today: string },
  calendar: VaccineCalendar = MADRID_2026,
): Array<PlannedMilestone<R>> {
  const byKey = new Map<string, R>();
  for (const r of input.records) {
    if ((r.deleted_at ?? null) !== null || r.dose_key === null) continue;
    const prev = byKey.get(r.dose_key);
    // `given` gana a `not_applicable`; entre dos `given`, la fecha más antigua (la primera vez que consta).
    if (prev === undefined || (r.status === 'given' && prev.status !== 'given') || (r.status === 'given' && prev.status === 'given' && (r.given_on ?? '') < (prev.given_on ?? ''))) {
      byKey.set(r.dose_key, r);
    }
  }
  return calendar.milestones.map((milestone) => {
    const dueDate = addMonths(input.birthDate, milestone.dueMonths);
    const doses: Array<PlannedDose<R>> = milestone.doses.map((dose) => {
      const record = byKey.get(dose.key) ?? null;
      const status: DoseStatus = record === null ? pendingStatus(dueDate, input.today) : record.status === 'given' ? 'given' : 'not_applicable';
      return { ...dose, status, record };
    });
    const pending = doses.filter((x) => x.status === 'unconfirmed' || x.status === 'soon' || x.status === 'later');
    const status: DoseStatus =
      pending.length > 0
        ? pending.reduce<DoseStatus>((worst, x) => (RANK[x.status] < RANK[worst] ? x.status : worst), 'later')
        : doses.some((x) => x.status === 'given')
          ? 'given'
          : 'not_applicable';
    return { milestone, dueDate, doses, status, daysToDue: Math.round((utcDay(dueDate) - utcDay(input.today)) / DAY_MS) };
  });
}

/** El primer hito con alguna dosis por confirmar o próxima: «lo siguiente». `null` si todo consta. */
export function nextMilestone<R extends VaccineRecordInput>(plan: ReadonlyArray<PlannedMilestone<R>>): PlannedMilestone<R> | null {
  const open = plan.filter((m) => m.status === 'unconfirmed' || m.status === 'soon');
  if (open.length > 0) return open[0] as PlannedMilestone<R>;
  return plan.find((m) => m.status === 'later') ?? null;
}
