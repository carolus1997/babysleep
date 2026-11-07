import { describe, expect, it } from 'vitest';
import { buildIcs, googleCalendarUrl, icsEscape, icsFold, icsUtc, reminderTimes, type CalendarEventInput } from '../src';

const ev: CalendarEventInput = {
  id: '0190a1b2-0000-7000-8000-000000000001',
  title: 'Pediatra, revisión de los 4 meses',
  start_utc: '2027-01-15T09:30:00.000Z',
  duration_min: 20,
  place: 'Centro de Salud de Prueba; planta 2',
  notes: 'Llevar el Documento de Salud Infantil\nTraer vacunas, si hay',
  remind_before_min: [60, 1440, 0],
};

describe('archivo de calendario (.ics)', () => {
  const ics = buildIcs([ev], { nowMs: Date.parse('2027-01-10T10:00:00Z') });
  const lines = ics.split('\r\n');

  it('es un VCALENDAR válido con líneas CRLF y un evento con identificador estable', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/); // ninguna línea termina solo en LF
    expect(lines).toContain(`UID:${ev.id}@babysleep`);
    expect(lines).toContain('DTSTART:20270115T093000Z');
    expect(lines).toContain('DTEND:20270115T095000Z'); // 20 min
    expect(lines).toContain('DTSTAMP:20270110T100000Z');
  });

  it('escapa comas, punto y coma y saltos de línea', () => {
    expect(lines).toContain('SUMMARY:Pediatra\\, revisión de los 4 meses');
    expect(lines).toContain('LOCATION:Centro de Salud de Prueba\\; planta 2');
    expect(ics).toContain('DESCRIPTION:Llevar el Documento de Salud Infantil\\nTraer vacunas\\, si hay');
  });

  it('crea un aviso por cada antelación, de mayor a menor, y 0 = a la hora', () => {
    const triggers = lines.filter((l) => l.startsWith('TRIGGER:'));
    expect(triggers).toEqual(['TRIGGER:-PT1440M', 'TRIGGER:-PT60M', 'TRIGGER:PT0S']);
    expect(lines.filter((l) => l === 'BEGIN:VALARM')).toHaveLength(3);
  });

  it('sin duración usa 30 min y una cita cancelada se marca como tal', () => {
    const x = buildIcs([{ ...ev, duration_min: null, status: 'cancelled', remind_before_min: [] }], { nowMs: 0 });
    expect(x).toContain('DTEND:20270115T100000Z');
    expect(x).toContain('STATUS:CANCELLED');
    expect(x).not.toContain('VALARM');
  });

  it('ninguna línea supera los 75 octetos y el texto plegado se recompone sin partir caracteres', () => {
    const long = 'Revisión con acentos ñ é ü y emojis 🍼 '.repeat(8);
    const out = buildIcs([{ ...ev, notes: long }], { nowMs: 0 });
    const enc = new TextEncoder();
    for (const l of out.split('\r\n')) expect(enc.encode(l).length).toBeLessThanOrEqual(75);
    const unfolded = out.replace(/\r\n /g, '');
    expect(unfolded).toContain(`DESCRIPTION:${icsEscape(long)}`);
  });
});

describe('piezas', () => {
  it('formatea instantes UTC como iCalendar', () => {
    expect(icsUtc(Date.parse('2027-12-31T23:59:58Z'))).toBe('20271231T235958Z');
    expect(icsUtc(Date.parse('2027-03-05T04:05:06Z'))).toBe('20270305T040506Z');
  });

  it('no pliega las líneas cortas y pliega las largas con un espacio', () => {
    expect(icsFold('A:corta')).toBe('A:corta');
    const f = icsFold('X:' + 'a'.repeat(200));
    expect(f.split('\r\n').length).toBeGreaterThan(2);
    expect(f.split('\r\n').slice(1).every((l) => l.startsWith(' '))).toBe(true);
  });

  it('el enlace de Google lleva título, fechas en UTC, lugar y detalles codificados', () => {
    const url = new URL(googleCalendarUrl(ev));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe(ev.title);
    expect(url.searchParams.get('dates')).toBe('20270115T093000Z/20270115T095000Z');
    expect(url.searchParams.get('location')).toBe(ev.place);
    expect(url.searchParams.get('details')).toBe(ev.notes);
  });

  it('los avisos se calculan desde el inicio, sin repetidos y ordenados', () => {
    const t = reminderTimes('2027-01-15T09:30:00.000Z', [60, 1440, 60, 0]);
    expect(t).toEqual([Date.parse('2027-01-14T09:30:00Z'), Date.parse('2027-01-15T08:30:00Z'), Date.parse('2027-01-15T09:30:00Z')]);
  });
});
