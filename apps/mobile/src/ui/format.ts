import { ageDays, correctedAgeDays, formatLocal } from '@babysleep/core';

/** «1 h 25 min», «40 min», «<1 min». */
export function fmtDur(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (ms > 0 && totalMin === 0) return '<1 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Cronómetro `H:MM:SS`. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function fmtClock(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).format(ms);
}

/** `2027-01-15` → «vie 15 ene». */
export function fmtDayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
}

export function fmtDayShort(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('es-ES', { weekday: 'narrow', timeZone: 'UTC' }).format(d).toUpperCase();
}

/** Valor para `<input type="datetime-local">` (hora de pared en la zona de referencia). */
export function toLocalInput(ms: number, zone: string): string {
  return formatLocal(ms, zone).slice(0, 16).replace(' ', 'T');
}

/** Edad aproximada: «3 meses y 2 semanas», «5 semanas», «12 días». */
/** Etiqueta de una edad expresada en días: «5 días», «6 semanas», «3 meses y 2 sem». */
export function fmtAgeDays(days: number): string {
  if (days < 14) return `${days} días`;
  if (days < 60) return `${Math.floor(days / 7)} semanas`;
  const months = Math.floor(days / 30.4375);
  const weeks = Math.floor((days - months * 30.4375) / 7);
  const mTxt = `${months} ${months === 1 ? 'mes' : 'meses'}`;
  return weeks > 0 && months < 12 ? `${mTxt} y ${weeks} sem` : mTxt;
}

export function fmtAge(birthDate: string, nowMs: number): string {
  return fmtAgeDays(ageDays(birthDate, nowMs));
}

/**
 * Edad real y, si nació antes de la semana 37 y tiene menos de 24 meses, también la corregida
 * (`null` si no procede). Antes de la fecha prevista de parto, la corregida se dice con palabras.
 */
export function fmtAges(birthDate: string, gestationalWeeks: number | null | undefined, nowMs: number): { age: string; corrected: string | null } {
  const c = correctedAgeDays(birthDate, gestationalWeeks, nowMs);
  return {
    age: fmtAge(birthDate, nowMs),
    corrected: c === null ? null : c <= 0 ? 'aún no llega a su fecha prevista' : fmtAgeDays(c),
  };
}

export function download(file: { filename: string; mime: string; content: string }): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
