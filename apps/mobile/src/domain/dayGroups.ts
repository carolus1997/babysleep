const MS_DAY = 86_400_000;
const at = (date: string): number => Date.parse(`${date}T12:00:00Z`);
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Lunes de la semana (ISO) a la que pertenece una fecha `YYYY-MM-DD`. */
export function weekStart(date: string): string {
  const dow = (new Date(at(date)).getUTCDay() + 6) % 7; // 0 = lunes
  return iso(at(date) - dow * MS_DAY);
}

export interface WeekGroup {
  /** Lunes de la semana (sirve de clave). */
  key: string;
  start: string;
  end: string;
  /** Fechas de la semana presentes en la lista, de más reciente a más antigua. */
  dates: string[];
}

/**
 * Para las listas por días (Sueño, Tomas): los últimos `recentDays` días se muestran uno a uno y los anteriores se
 * agrupan por semana (lunes a domingo) para que la lista no crezca sin fin.
 * `datesDesc`: fechas `YYYY-MM-DD` de más reciente a más antigua; `today`: hoy en la zona de la familia.
 */
export function splitRecentAndWeeks(datesDesc: readonly string[], today: string, recentDays = 7): { recent: string[]; weeks: WeekGroup[] } {
  const limit = at(today) - recentDays * MS_DAY;
  const recent: string[] = [];
  const weeks: WeekGroup[] = [];
  for (const d of datesDesc) {
    if (at(d) > limit) {
      recent.push(d);
      continue;
    }
    const key = weekStart(d);
    const last = weeks[weeks.length - 1];
    if (last && last.key === key) last.dates.push(d);
    else weeks.push({ key, start: key, end: iso(at(key) + 6 * MS_DAY), dates: [d] });
  }
  return { recent, weeks };
}
