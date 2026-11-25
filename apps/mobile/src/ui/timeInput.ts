/**
 * Lógica del campo de hora escrita («00 : 00»). El valor es la hora local de pared `YYYY-MM-DDTHH:mm`; `''` es «sin
 * hora» y cualquier otra cosa es una hora a medio escribir, que NO se puede guardar (nunca se completa en silencio).
 */
export interface TimeParts {
  date: string;
  hh: string;
  mm: string;
}

const COMPLETE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export const isCompleteLocal = (value: string): boolean => {
  if (!COMPLETE.test(value)) return false;
  return Number(value.slice(11, 13)) <= 23 && Number(value.slice(14, 16)) <= 59;
};

export function splitLocal(value: string): TimeParts {
  const [date = '', time = ''] = value.split('T');
  const [hh = '', mm = ''] = time.split(':');
  return { date, hh, mm };
}

export function joinLocal(p: TimeParts): string {
  if (p.hh === '' && p.mm === '') return '';
  return `${p.date}T${p.hh}:${p.mm}`;
}

/**
 * Lo tecleado en una casilla. Se quedan los dos últimos dígitos y `done` dice si hay que saltar a la siguiente: con
 * dos cifras, o con una primera cifra que ya no admite otra (3-9 en las horas, 6-9 en los minutos), que se completa
 * con un cero delante.
 */
export function typeDigits(raw: string, part: 'hh' | 'mm'): { value: string; done: boolean } {
  const digits = raw.replace(/\D/g, '').slice(-2);
  const max = part === 'hh' ? 23 : 59;
  if (digits.length === 2) {
    // Un número imposible (p. ej. 28 en las horas) se queda con la última cifra para volver a escribirlo.
    if (Number(digits) > max) return typeDigits(digits.slice(-1), part);
    return { value: digits, done: true };
  }
  if (digits.length === 1 && Number(digits) > Math.floor(max / 10)) return { value: `0${digits}`, done: true };
  return { value: digits, done: false };
}

/** Lo que se ha añadido a una casilla que tenía `before`: si no estaba seleccionada, la cifra queda pegada a lo anterior. */
export function addedText(before: string, raw: string): string {
  if (before === '' || raw.length !== before.length + 1) return raw;
  let i = 0;
  while (i < before.length && raw[i] === before[i]) i++;
  return raw[i] as string;
}

/** Una hora entera pegada o dictada de golpe («2005», «20:05»), o `null` si no lo es. */
export function wholeTime(raw: string): { hh: string; mm: string } | null {
  const m = /^(\d{2})[:.h ]?(\d{2})$/.exec(raw.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { hh: m[1] as string, mm: m[2] as string };
}

/** Al salir de una casilla, una sola cifra se completa («7» → «07»). */
export const padPart = (v: string): string => (v.length === 1 ? `0${v}` : v);

/**
 * Fecha para una hora escrita en un campo que estaba vacío: la de `after` (p. ej. cuando se durmió) y, si la hora
 * queda antes, el día siguiente (una noche que acaba por la mañana).
 */
export function dateAfter(after: string, hh: string, mm: string): string {
  const day = after.slice(0, 10);
  if (`${day}T${hh}:${mm}` > after) return day;
  const next = new Date(`${day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
