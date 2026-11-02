import { describe, expect, it } from 'vitest';
import {
  AggregateItem,
  Baby,
  Family,
  Observation,
  SettlingAttempt,
  SleepSession,
  Tag,
} from '../src';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number) => ({
  id: U(n),
  family_id: U(900),
  rev: 1,
  change_seq: null,
  created_at: '2027-01-14T10:00:00.000Z',
  updated_at: '2027-01-14T10:00:00.000Z',
  created_by: null,
  updated_by: null,
  origin_device_id: null,
  deleted_at: null,
});

const sleepSession = (over: Record<string, unknown> = {}) => ({
  ...row(1),
  baby_id: U(2),
  sleep_start_utc: '2027-01-14T20:00:00.000Z',
  sleep_end_utc: '2027-01-15T05:00:00.000Z',
  start_tz: 'Europe/Madrid',
  end_tz: 'Europe/Madrid',
  end_quality: 'exact',
  sleep_type: 'night',
  type_source: 'manual',
  settling_attempt_id: null,
  merged_into: null,
  source: 'manual',
  ...over,
});

describe('contrato SleepSession', () => {
  it('acepta una sesión válida y aplica los valores por defecto', () => {
    const s = SleepSession.parse(sleepSession());
    expect(s.awakenings_completeness).toBe('unknown');
    expect(s.interval_semantics).toBe('observed_asleep_to_observed_awake');
    expect(s.start_quality).toBe('exact');
    expect(s.conflict_open).toBe(false);
  });

  it('acepta una sesión abierta', () => {
    expect(SleepSession.safeParse(sleepSession({ sleep_end_utc: null, end_tz: null, end_quality: null })).success).toBe(true);
  });

  it('rechaza un fin anterior o igual al inicio', () => {
    expect(SleepSession.safeParse(sleepSession({ sleep_end_utc: '2027-01-14T20:00:00.000Z' })).success).toBe(false);
    expect(SleepSession.safeParse(sleepSession({ sleep_end_utc: '2027-01-14T19:00:00.000Z' })).success).toBe(false);
  });

  it('rechaza instantes con offset y semánticas desconocidas', () => {
    expect(SleepSession.safeParse(sleepSession({ sleep_start_utc: '2027-01-14T21:00:00+01:00' })).success).toBe(false);
    expect(SleepSession.safeParse(sleepSession({ interval_semantics: 'put_down' })).success).toBe(false);
  });
});

describe('contrato SettlingAttempt', () => {
  const attempt = (over: Record<string, unknown> = {}) => ({
    ...row(3),
    baby_id: U(2),
    started_utc: '2027-01-14T19:40:00.000Z',
    put_down_utc: null,
    started_quality: 'exact',
    put_down_quality: null,
    tz: 'Europe/Madrid',
    status: 'open',
    ...over,
  });
  it('necesita al menos una marca', () => {
    expect(SettlingAttempt.safeParse(attempt()).success).toBe(true);
    expect(SettlingAttempt.safeParse(attempt({ started_utc: null, put_down_utc: '2027-01-14T19:50:00.000Z' })).success).toBe(true);
    expect(SettlingAttempt.safeParse(attempt({ started_utc: null })).success).toBe(false);
  });
});

describe('contrato Observation', () => {
  const obs = (over: Record<string, unknown> = {}) => ({
    ...row(4),
    session_id: U(1),
    settling_attempt_id: null,
    moment: 'onset',
    occurred_utc: null,
    note_text: 'Costó dormirlo',
    ...over,
  });
  it('se vincula a una sesión o a un intento, nunca a ambos ni a ninguno', () => {
    expect(Observation.safeParse(obs()).success).toBe(true);
    expect(Observation.safeParse(obs({ session_id: null, settling_attempt_id: U(3), moment: 'settling' })).success).toBe(true);
    expect(Observation.safeParse(obs({ settling_attempt_id: U(3) })).success).toBe(false);
    expect(Observation.safeParse(obs({ session_id: null })).success).toBe(false);
  });
});

describe('contrato Baby', () => {
  const baby = (over: Record<string, unknown> = {}) => ({ ...row(9), alias: 'Lía', birth_date: '2026-07-01', color: null, ...over });
  it('los datos opcionales son null por defecto (una fila antigua sigue siendo válida)', () => {
    const b = Baby.parse(baby());
    expect([b.sex, b.gestational_weeks, b.birth_weight_g, b.birth_length_cm, b.notes]).toEqual([null, null, null, null, null]);
  });
  it('acepta valores plausibles y rechaza los imposibles', () => {
    expect(Baby.safeParse(baby({ sex: 'female', gestational_weeks: 40, birth_weight_g: 3300, birth_length_cm: 50.5 })).success).toBe(true);
    for (const bad of [{ sex: 'x' }, { gestational_weeks: 21 }, { gestational_weeks: 38.5 }, { birth_weight_g: 0 }, { birth_length_cm: 100 }]) {
      expect(Baby.safeParse(baby(bad)).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('otros contratos', () => {
  it('Tag exige slug estable en minúsculas', () => {
    const tag = (slug: string) => ({
      ...row(5),
      tag_slug: slug,
      category: 'settling_difficulty',
      kind: 'system',
      label_i18n: { es: 'Le costó dormirse' },
    });
    expect(Tag.safeParse(tag('settling.hard_to_fall_asleep')).success).toBe(true);
    expect(Tag.safeParse(tag('Le costó')).success).toBe(false);
  });

  it('AggregateItem fija exhaustividad desconocida y semántica', () => {
    const item = AggregateItem.parse({ ...row(6), period_id: U(7), kind: 'night', ordinal: 0, duration_s: 36000 });
    expect(item.awakenings_completeness).toBe('unknown');
    expect(item.interval_semantics).toBe('observed_asleep_to_observed_awake');
    expect(AggregateItem.safeParse({ ...row(6), period_id: U(7), kind: 'night', ordinal: 0, duration_s: 36000, awakenings_completeness: 'complete' }).success).toBe(false);
  });

  it('Family aplica las tolerancias aprobadas por defecto', () => {
    const f = Family.parse({ ...row(8), name: 'Familia' });
    expect(f.home_tz).toBe('Europe/Madrid');
    expect(f.settings).toEqual({
      end_conflict_tolerance_s: 120,
      duplicate_start_tolerance_s: 300,
      latency_review_threshold_s: 10800,
    });
  });
});
