import { describe, expect, it } from 'vitest';
import { effectiveSleep, settlingLatency, summarizeLatency, type LatencyResult } from '../src';
import { HOUR, iso, MIN } from './helpers';

const sess = (startLocal: string, q: 'exact' | 'approx' = 'exact') => ({
  sleep_start_utc: iso(startLocal),
  start_quality: q,
});
const att = (startLocal: string | null, q: 'exact' | 'approx' | null = 'exact') => ({
  started_utc: startLocal === null ? null : iso(startLocal),
  started_quality: q,
});

describe('latencia de conciliación', () => {
  it('es inicio del sueño observado menos inicio del intento', () => {
    const r = settlingLatency(att('2027-01-14T20:40'), sess('2027-01-14T21:05'));
    expect(r).toEqual({ status: 'ok', ms: 25 * MIN, quality: 'exact' });
  });

  it('sin intento registrado es DESCONOCIDA, no cero', () => {
    expect(settlingLatency(null, sess('2027-01-14T21:05'))).toEqual({ status: 'unknown', reason: 'no_attempt' });
    expect(settlingLatency(att(null), sess('2027-01-14T21:05'))).toEqual({ status: 'unknown', reason: 'no_attempt_start' });
  });

  it('cero medido (se durmió al instante) es un valor válido distinto de desconocido', () => {
    expect(settlingLatency(att('2027-01-14T21:05'), sess('2027-01-14T21:05'))).toEqual({ status: 'ok', ms: 0, quality: 'exact' });
  });

  it('intento posterior al sueño observado es anomalía y no genera valor', () => {
    expect(settlingLatency(att('2027-01-14T21:10'), sess('2027-01-14T21:05'))).toEqual({
      status: 'anomaly',
      reason: 'attempt_after_sleep',
    });
  });

  it('la colocación en la cuna no interviene (ni siquiera posterior al sueño)', () => {
    const attempt = { ...att('2027-01-14T20:40'), put_down_utc: iso('2027-01-14T21:30') };
    const r = settlingLatency(attempt, sess('2027-01-14T21:05'));
    expect(r).toEqual({ status: 'ok', ms: 25 * MIN, quality: 'exact' });
  });

  it('por encima de 3 h se marca para revisión conservando el valor; en 3 h exactas es válida', () => {
    expect(settlingLatency(att('2027-01-14T18:05'), sess('2027-01-14T21:05')).status).toBe('ok');
    expect(settlingLatency(att('2027-01-14T18:04'), sess('2027-01-14T21:05'))).toEqual({
      status: 'needs_review',
      ms: 3 * HOUR + MIN,
      quality: 'exact',
    });
  });

  it('el umbral es configurable', () => {
    const r = settlingLatency(att('2027-01-14T20:00'), sess('2027-01-14T21:05'), { reviewThresholdMs: HOUR });
    expect(r.status).toBe('needs_review');
  });

  it('hereda la calidad aproximada de cualquiera de los extremos', () => {
    expect(settlingLatency(att('2027-01-14T20:40', 'approx'), sess('2027-01-14T21:05'))).toMatchObject({ quality: 'approx' });
    expect(settlingLatency(att('2027-01-14T20:40'), sess('2027-01-14T21:05', 'approx'))).toMatchObject({ quality: 'approx' });
    // calidad ausente con hora presente: no se afirma exactitud
    expect(settlingLatency(att('2027-01-14T20:40', null), sess('2027-01-14T21:05'))).toMatchObject({ quality: 'approx' });
  });

  it('caso 8: atraviesa el salto de primavera → 20 min reales, no 80', () => {
    const r = settlingLatency(att('2027-03-28T01:50'), sess('2027-03-28T03:10'));
    expect(r).toEqual({ status: 'ok', ms: 20 * MIN, quality: 'exact' });
  });

  it('retroceso de otoño: intento 02:50 CEST y sueño 02:10 CET → 20 min reales (el reloj "retrocede" 40)', () => {
    const attempt = { started_utc: '2026-10-25T00:50:00.000Z', started_quality: 'exact' as const };
    const s = { sleep_start_utc: '2026-10-25T01:10:00.000Z', start_quality: 'exact' as const };
    expect(settlingLatency(attempt, s)).toMatchObject({ status: 'ok', ms: 20 * MIN });
  });
});

describe('resumen de latencia', () => {
  const ok = (min: number, q: 'exact' | 'approx' = 'exact'): LatencyResult => ({ status: 'ok', ms: min * MIN, quality: q });

  it('solo resume las válidas y cuenta las excluidas', () => {
    const results: LatencyResult[] = [
      ok(10),
      ok(20),
      ok(30, 'approx'),
      { status: 'unknown', reason: 'no_attempt' },
      { status: 'needs_review', ms: 4 * HOUR, quality: 'exact' },
      { status: 'anomaly', reason: 'attempt_after_sleep' },
    ];
    const s = summarizeLatency(results);
    expect(s.n).toBe(3);
    expect(s.excluded).toEqual({ unknown: 1, needs_review: 1, anomaly: 1 });
    expect(s.medianMs).toBe(20 * MIN);
    expect(s.meanMs).toBe(20 * MIN);
    expect(s.approxCount).toBe(1);
    expect(s.sdMs).toBeCloseTo(10 * MIN, 6);
  });

  it('con una sola latencia no hay desviación estándar; sin datos todo es null', () => {
    expect(summarizeLatency([ok(15)]).sdMs).toBeNull();
    const empty = summarizeLatency([{ status: 'unknown', reason: 'no_attempt' }]);
    expect(empty.n).toBe(0);
    expect(empty.meanMs).toBeNull();
    expect(empty.medianMs).toBeNull();
  });
});

describe('tiempo efectivo dormido (rango)', () => {
  const night = { sleep_start_utc: iso('2027-01-14T21:00'), sleep_end_utc: iso('2027-01-15T06:00') }; // 9 h
  const ep = (a: string, b: string, extra = {}) => ({
    kind: 'timed' as const,
    start_utc: iso(a),
    end_utc: iso(b),
    duration_s: null,
    ...extra,
  });

  it('sin despertares registrados y exhaustividad desconocida: solo cota superior', () => {
    const r = effectiveSleep(night, [], 'unknown');
    expect(r).toMatchObject({ recordedMs: 9 * HOUR, awakeKnownMs: 0, asleepUpperBoundMs: 9 * HOUR, asleepPointMs: null });
  });

  it('con exhaustividad completa hay valor puntual', () => {
    const r = effectiveSleep(night, [ep('2027-01-15T02:00', '2027-01-15T02:30')], 'complete');
    expect(r?.asleepPointMs).toBe(8.5 * HOUR);
  });

  it('los episodios solapados no se cuentan dos veces', () => {
    const r = effectiveSleep(night, [ep('2027-01-15T02:00', '2027-01-15T02:20'), ep('2027-01-15T02:10', '2027-01-15T02:30')], 'partial');
    expect(r?.awakeKnownMs).toBe(30 * MIN);
    expect(r?.asleepPointMs).toBeNull();
  });

  it('un episodio fuera de la sesión se recorta', () => {
    const r = effectiveSleep(night, [ep('2027-01-14T20:30', '2027-01-14T21:10')], 'partial');
    expect(r?.awakeKnownMs).toBe(10 * MIN);
  });

  it('episodios solo con duración se suman y se avisa', () => {
    const r = effectiveSleep(night, [{ kind: 'duration_only', start_utc: null, end_utc: null, duration_s: 600 }], 'partial');
    expect(r?.awakeKnownMs).toBe(10 * MIN);
    expect(r?.awakeIncludesDurationOnly).toBe(true);
  });

  it('episodios eliminados o sin extensión no se cuentan; los incompletos se informan', () => {
    const r = effectiveSleep(
      night,
      [
        ep('2027-01-15T02:00', '2027-01-15T02:30', { deleted_at: '2027-01-15T07:00:00.000Z' }),
        { kind: 'timed', start_utc: iso('2027-01-15T03:00'), end_utc: null, duration_s: null },
      ],
      'partial',
    );
    expect(r?.awakeKnownMs).toBe(0);
    expect(r?.ignoredEpisodes).toBe(1);
  });

  it('el tiempo despierto no puede superar la duración registrada', () => {
    const r = effectiveSleep(night, [{ kind: 'duration_only', start_utc: null, end_utc: null, duration_s: 20 * 3600 }], 'partial');
    expect(r?.awakeKnownMs).toBe(9 * HOUR);
    expect(r?.asleepUpperBoundMs).toBe(0);
  });

  it('sesión abierta: no hay efectivo calculable', () => {
    expect(effectiveSleep({ sleep_start_utc: night.sleep_start_utc, sleep_end_utc: null }, [], 'unknown')).toBeNull();
  });

  it('nunca modifica la duración registrada original', () => {
    const r = effectiveSleep(night, [ep('2027-01-15T02:00', '2027-01-15T03:00')], 'complete');
    expect(r?.recordedMs).toBe(9 * HOUR);
  });
});
