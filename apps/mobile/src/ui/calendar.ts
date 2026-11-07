import { buildIcs, type CalendarEventInput } from '@babysleep/core';
import { download } from './format';

/** Nombre de archivo seguro a partir de un título: sin acentos ni símbolos, y con la extensión `.ics`. */
export function icsFilename(title: string): string {
  const base = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base === '' ? 'cita' : base.toLowerCase()}.ics`;
}

/**
 * Entrega el `.ics` de una cita. En iPhone y Android lo normal es la hoja de compartir con el archivo (de ahí se
 * añade al calendario); si el navegador no la admite, se descarga. Devuelve cómo salió, para avisar a la persona.
 */
export async function shareOrDownloadIcs(event: CalendarEventInput, nowMs: number, alarmText?: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const content = buildIcs([event], { nowMs, ...(alarmText === undefined ? {} : { alarmText }) });
  const filename = icsFilename(event.title);
  try {
    const file = new File([content], filename, { type: 'text/calendar' });
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: event.title });
      return 'shared';
    }
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return 'cancelled'; // cerró la hoja de compartir
    // cualquier otro fallo: se cae a la descarga
  }
  download({ filename, mime: 'text/calendar', content });
  return 'downloaded';
}
