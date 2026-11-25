import { describe, expect, it } from 'vitest';
import { addedText, dateAfter, isCompleteLocal, joinLocal, padPart, splitLocal, typeDigits, wholeTime } from '../src/ui/timeInput';

describe('hora escrita 00:00', () => {
  it('salta a los minutos al completar las horas', () => {
    expect(typeDigits('2', 'hh')).toEqual({ value: '2', done: false });
    expect(typeDigits('20', 'hh')).toEqual({ value: '20', done: true });
    expect(typeDigits('0', 'hh')).toEqual({ value: '0', done: false });
    expect(typeDigits('07', 'hh')).toEqual({ value: '07', done: true });
  });

  it('una primera cifra que no admite otra se completa sola', () => {
    expect(typeDigits('7', 'hh')).toEqual({ value: '07', done: true });
    expect(typeDigits('6', 'mm')).toEqual({ value: '06', done: true });
    expect(typeDigits('5', 'mm')).toEqual({ value: '5', done: false });
  });

  it('descarta lo que no es un dígito y los números imposibles', () => {
    expect(typeDigits('a', 'hh')).toEqual({ value: '', done: false });
    expect(typeDigits('28', 'hh')).toEqual({ value: '08', done: true });
    expect(typeDigits('123', 'hh')).toEqual({ value: '23', done: true });
  });

  it('la primera cifra sustituye aunque no haya selección, y una hora pegada se reparte', () => {
    expect(addedText('55', '554')).toBe('4');
    expect(addedText('55', '455')).toBe('4');
    expect(addedText('55', '4')).toBe('4');
    expect(wholeTime('2005')).toEqual({ hh: '20', mm: '05' });
    expect(wholeTime('07:45')).toEqual({ hh: '07', mm: '45' });
    expect(wholeTime('745')).toBeNull();
    expect(wholeTime('2890')).toBeNull();
  });

  it('una hora a medias no está completa ni cuenta como vacía', () => {
    const half = joinLocal({ date: '2026-11-25', hh: '20', mm: '' });
    expect(half).not.toBe('');
    expect(isCompleteLocal(half)).toBe(false);
    expect(isCompleteLocal(joinLocal({ date: '', hh: '20', mm: '34' }))).toBe(false);
    expect(joinLocal({ date: '2026-11-25', hh: '', mm: '' })).toBe('');
  });

  it('ida y vuelta de un valor completo', () => {
    const v = '2026-11-25T07:05';
    expect(isCompleteLocal(v)).toBe(true);
    expect(joinLocal(splitLocal(v))).toBe(v);
    expect(padPart('7')).toBe('07');
  });

  it('un fin anterior al inicio cae al día siguiente', () => {
    expect(dateAfter('2026-11-30T20:34', '07', '49')).toBe('2026-12-01');
    expect(dateAfter('2026-11-30T14:17', '15', '09')).toBe('2026-11-30');
  });
});
