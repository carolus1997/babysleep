import { describe, expect, it } from 'vitest';
import { addMonths, MADRID_2026, nextMilestone, pendingStatus, vaccinePlan, type VaccineRecordInput } from '../src';

const rec = (dose_key: string | null, given_on: string | null, extra: Partial<VaccineRecordInput> = {}): VaccineRecordInput => ({
  id: `r-${dose_key}-${given_on}`,
  dose_key,
  status: 'given',
  given_on,
  ...extra,
});

describe('calendario de Madrid 2026', () => {
  it('cada dosis tiene una clave única y estable ANTÍGENO@hito', () => {
    const keys = MADRID_2026.milestones.flatMap((m) => m.doses.map((x) => x.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('DTPa@2m');
    expect(keys).toContain('MenACWY@12m');
    for (const m of MADRID_2026.milestones) for (const x of m.doses) expect(x.key.endsWith(`@${m.id}`)).toBe(true);
  });

  it('los hitos van por edad creciente y reflejan el calendario oficial', () => {
    const months = MADRID_2026.milestones.map((m) => m.dueMonths);
    expect([...months].sort((a, b) => a - b)).toEqual(months);
    const doses = (id: string) => MADRID_2026.milestones.find((m) => m.id === id)!.doses.map((x) => x.antigen);
    expect(doses('2m')).toEqual(['VHB', 'DTPa', 'VPI', 'Hib', 'VNC', 'MenB', 'RV']);
    expect(doses('4m')).toEqual(['VHB', 'DTPa', 'VPI', 'Hib', 'VNC', 'MenB', 'MenC', 'RV']);
    expect(doses('11m')).toEqual(['VHB', 'DTPa', 'VPI', 'Hib', 'VNC']);
    expect(doses('12m')).toEqual(['TV', 'MenB', 'MenACWY']);
    expect(doses('15m')).toEqual(['VVZ']);
  });
});

describe('fechas previstas', () => {
  it('suma meses de calendario recortando al último día del mes', () => {
    expect(addMonths('2026-07-01', 2)).toBe('2026-09-01');
    expect(addMonths('2026-12-31', 2)).toBe('2027-02-28');
    expect(addMonths('2027-12-31', 2)).toBe('2028-02-29'); // año bisiesto
    expect(addMonths('2026-07-01', 12)).toBe('2027-07-01');
  });

  it('estado de una dosis sin registro según lo que falta para su fecha', () => {
    expect(pendingStatus('2027-01-01', '2026-10-01')).toBe('later');
    expect(pendingStatus('2027-01-01', '2026-12-10')).toBe('soon'); // en 22 días
    expect(pendingStatus('2027-01-01', '2027-01-20')).toBe('soon'); // acaba de pasar
    expect(pendingStatus('2027-01-01', '2027-03-15')).toBe('unconfirmed');
  });
});

describe('plan de vacunación', () => {
  const plan = (records: VaccineRecordInput[], today: string, birthDate = '2026-07-01') => vaccinePlan({ birthDate, records, today });
  const m = (p: ReturnType<typeof plan>, id: string) => p.find((x) => x.milestone.id === id)!;

  it('sin registros: los hitos pasados quedan «sin confirmar», no «no puestas»', () => {
    const p = plan([], '2026-12-01'); // 5 meses
    expect(m(p, '2m')).toMatchObject({ dueDate: '2026-09-01', status: 'unconfirmed' });
    expect(m(p, '4m')).toMatchObject({ dueDate: '2026-11-01', status: 'soon' }); // pasó hace 30 días: aún en margen
    expect(m(p, '11m').status).toBe('later');
    expect(m(p, '2m').doses.every((d) => d.record === null)).toBe(true);
  });

  it('una dosis puesta consta como tal; el hito sigue pendiente mientras falte alguna', () => {
    const p = plan([rec('DTPa@2m', '2026-09-03'), rec('VHB@2m', '2026-09-03')], '2026-12-01');
    const h = m(p, '2m');
    expect(h.doses.find((d) => d.key === 'DTPa@2m')?.status).toBe('given');
    expect(h.doses.find((d) => d.key === 'RV@2m')?.status).toBe('unconfirmed');
    expect(h.status).toBe('unconfirmed');
  });

  it('con todas las dosis del hito puestas (o no procede) el hito está completo', () => {
    const all = MADRID_2026.milestones[0]!.doses.map((d, i) => rec(d.key, '2026-09-03', i === 0 ? { status: 'not_applicable', given_on: null } : {}));
    expect(m(plan(all, '2026-12-01'), '2m').status).toBe('given');
    const allNa = MADRID_2026.milestones[0]!.doses.map((d) => rec(d.key, null, { status: 'not_applicable' }));
    expect(m(plan(allNa, '2026-12-01'), '2m').status).toBe('not_applicable');
  });

  it('los registros eliminados y las vacunas fuera de calendario no cuentan para una dosis', () => {
    const p = plan([rec('DTPa@2m', '2026-09-03', { deleted_at: '2026-10-01T00:00:00Z' }), rec(null, '2026-09-03')], '2026-12-01');
    expect(m(p, '2m').doses.find((d) => d.key === 'DTPa@2m')?.status).toBe('unconfirmed');
  });

  it('con un duplicado de la misma dosis gana el registro «puesta» más antiguo; «puesta» gana a «no procede»', () => {
    const p = plan(
      [rec('DTPa@2m', '2026-09-10'), rec('DTPa@2m', '2026-09-03'), rec('VPI@2m', null, { status: 'not_applicable' }), rec('VPI@2m', '2026-09-03')],
      '2026-12-01',
    );
    const h = m(p, '2m');
    expect(h.doses.find((d) => d.key === 'DTPa@2m')?.record?.given_on).toBe('2026-09-03');
    expect(h.doses.find((d) => d.key === 'VPI@2m')?.status).toBe('given');
  });

  it('las fechas se cuentan desde el nacimiento: la prematuridad no las retrasa', () => {
    const p = vaccinePlan({ birthDate: '2026-07-01', records: [], today: '2026-07-01' });
    expect(p[0]!.dueDate).toBe('2026-09-01');
  });

  it('«lo siguiente» es el primer hito por confirmar o próximo; si todo consta, el siguiente futuro; si no queda nada, null', () => {
    const p = plan([], '2026-12-01');
    expect(nextMilestone(p)?.milestone.id).toBe('2m');
    const done = MADRID_2026.milestones.flatMap((x) => x.doses.map((d) => rec(d.key, '2026-09-03')));
    expect(nextMilestone(plan(done, '2026-12-01'))).toBeNull();
    const upTo4 = MADRID_2026.milestones.slice(0, 2).flatMap((x) => x.doses.map((d) => rec(d.key, '2026-11-03')));
    expect(nextMilestone(plan(upTo4, '2026-12-01'))?.milestone.id).toBe('11m');
  });
});
