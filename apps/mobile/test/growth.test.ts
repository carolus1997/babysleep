import { describe, expect, it } from 'vitest';
import { createBaby, renameBaby } from '../src/domain/bootstrap';
import { DomainError } from '../src/domain/context';
import { buildBackupJson } from '../src/domain/export';
import { addGrowth, deleteGrowth, editGrowth, listGrowth, pointsFor, restoreGrowth } from '../src/domain/growth';
import { applyImport, planImport } from '../src/domain/import';
import { mergeBabies } from '../src/domain/merge';
import { describeConflict, describeValue } from '../src/sync/conflicts';
import { parseDecimal } from '../src/screens/Growth';
import { makeHarness } from './harness';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof DomainError ? e.code : 'other';
  }
};

const setup = async () => {
  const h = await makeHarness('2027-01-20T12:00');
  const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
  return { h, baby };
};

describe('medidas de crecimiento', () => {
  it('guarda enteros (g y mm); lo que no se mide es null, nunca 0; los textos se recortan', async () => {
    const { h, baby } = await setup();
    const g = await addGrowth(h.ctx, { babyId: baby.id, measuredOn: '2027-01-10', weightG: 5600, headMm: 405, place: '  Centro de prueba ', notes: '   ' });
    expect(g).toMatchObject({ weight_g: 5600, length_mm: null, head_mm: 405, place: 'Centro de prueba', notes: null });
  });

  it('valida: al menos una medida, valores posibles, fecha real, no futura y no anterior al nacimiento', async () => {
    const { h, baby } = await setup();
    const add = (o: object) => code(addGrowth(h.ctx, { babyId: baby.id, measuredOn: '2027-01-10', ...o }));
    expect(await add({})).toBe('invalid');
    expect(await add({ weightG: 0 })).toBe('invalid'); // 0 no es «no medido»
    expect(await add({ weightG: 100 })).toBe('invalid');
    expect(await add({ weightG: 5600.5 })).toBe('invalid');
    expect(await add({ lengthMm: 2000 })).toBe('invalid');
    expect(await add({ headMm: 700 })).toBe('invalid');
    expect(await add({ weightG: 5600, measuredOn: '2027-02-30' })).toBe('invalid');
    expect(await add({ weightG: 5600, measuredOn: '2027-01-21' })).toBe('invalid'); // mañana
    expect(await add({ weightG: 5600, measuredOn: '2026-08-31' })).toBe('invalid'); // antes de nacer
    expect(await add({ weightG: 5600 })).toBeNull();
    expect(await listGrowth(h.ctx, baby.id)).toHaveLength(1);
  });

  it('edita solo lo que cambia; no deja la visita sin ninguna medida; borra y restaura', async () => {
    const { h, baby } = await setup();
    const g = await addGrowth(h.ctx, { babyId: baby.id, measuredOn: '2027-01-10', weightG: 5600, headMm: 405 });
    h.ctx.db.syncEnabled = true;
    const rev = (await h.ctx.db.growth_measure.get(g.id))!.rev;
    await editGrowth(h.ctx, g.id, { weightG: 5600, headMm: 405, place: '' }); // nada cambia
    expect((await h.ctx.db.growth_measure.get(g.id))!.rev).toBe(rev);
    expect(await h.ctx.db.outbox.count()).toBe(0);

    await editGrowth(h.ctx, g.id, { weightG: 5650, headMm: 405 });
    expect((await h.ctx.db.outbox.toArray()).flatMap((e) => Object.keys(e.fields))).toEqual(['weight_g']);

    await editGrowth(h.ctx, g.id, { headMm: null });
    expect(await code(editGrowth(h.ctx, g.id, { weightG: null }))).toBe('invalid'); // se quedaría vacía
    expect((await listGrowth(h.ctx, baby.id))[0]).toMatchObject({ weight_g: 5650, head_mm: null });

    await deleteGrowth(h.ctx, g.id);
    expect(await listGrowth(h.ctx, baby.id)).toEqual([]);
    await restoreGrowth(h.ctx, g.id);
    expect(await listGrowth(h.ctx, baby.id)).toHaveLength(1);
  });

  it('las medidas salen ordenadas por fecha y con su percentil (peso al nacer)', async () => {
    const { h, baby } = await setup();
    await addGrowth(h.ctx, { babyId: baby.id, measuredOn: '2027-01-10', weightG: 5600 });
    await addGrowth(h.ctx, { babyId: baby.id, measuredOn: '2026-09-01', weightG: 3200 });
    const rows = await listGrowth(h.ctx, baby.id);
    expect(rows.map((r) => r.measured_on)).toEqual(['2026-09-01', '2027-01-10']);
    const b = (await h.ctx.db.baby.get(baby.id))!;
    const pts = pointsFor(b, rows);
    expect(pts[0]).toMatchObject({ ageDays: 0, corrected: false });
    expect(pts[0]!.percentile).toBeGreaterThan(40);
    expect(pts[0]!.percentile).toBeLessThan(55); // 3,2 kg es casi la mediana de la OMS al nacer (3,23)
  });

  it('prematura: la medida se sitúa con la edad corregida', async () => {
    const { h, baby } = await setup();
    await renameBaby(h.ctx, baby.id, { gestational_weeks: 30 });
    await addGrowth(h.ctx, { babyId: baby.id, measuredOn: '2027-01-10', weightG: 5000 });
    const b = (await h.ctx.db.baby.get(baby.id))!;
    const [p] = pointsFor(b, await listGrowth(h.ctx, baby.id));
    // 131 días cronológicos − 70 días que faltaron hasta las 40 semanas
    expect(p).toMatchObject({ ageDays: 61, corrected: true });
  });

  it('al fusionar dos perfiles las medidas pasan al que se conserva', async () => {
    const { h, baby } = await setup();
    const other = await createBaby(h.ctx, { alias: 'Duplicado', birthDate: '2026-09-01' });
    await addGrowth(h.ctx, { babyId: other.id, measuredOn: '2027-01-10', weightG: 5600 });
    await mergeBabies(h.ctx, other.id, baby.id);
    expect(await listGrowth(h.ctx, baby.id)).toHaveLength(1);
    expect(await listGrowth(h.ctx, other.id)).toEqual([]);
  });

  it('entran en la copia JSON y se restauran en un dispositivo nuevo', async () => {
    const { h, baby } = await setup();
    await addGrowth(h.ctx, { babyId: baby.id, measuredOn: '2027-01-10', weightG: 5600, headMm: 405, place: 'Centro de prueba' });
    const backup = await buildBackupJson(h.ctx);
    expect(JSON.parse(backup.content).tables.growth_measure).toHaveLength(1);

    const b = await makeHarness('2027-03-01T10:00');
    const plan = await planImport(b.ctx, backup.content);
    expect(plan.ok, plan.errors.join(' | ')).toBe(true);
    expect(plan.toAdd.growth_measure).toHaveLength(1);
    await applyImport(b.ctx, plan);
    const nb = (await b.ctx.db.baby.toArray())[0]!;
    expect(await listGrowth(b.ctx, nb.id)).toMatchObject([{ measured_on: '2027-01-10', weight_g: 5600, length_mm: null, head_mm: 405, place: 'Centro de prueba' }]);
  });
});

describe('texto de los conflictos de crecimiento', () => {
  it('se muestran en kg y cm, no en gramos y milímetros', () => {
    expect(describeValue('weight_g', 5650, 'Europe/Madrid')).toBe('5,65 kg');
    expect(describeValue('length_mm', 625, 'Europe/Madrid')).toBe('62,5 cm');
    expect(describeValue('head_mm', 405, 'Europe/Madrid')).toBe('40,5 cm');
    expect(describeValue('measured_on', '2027-01-10', 'Europe/Madrid')).toMatch(/2027/);
    expect(describeValue('weight_g', null, 'Europe/Madrid')).toBe('vacío');
    const v = describeConflict({ id: 'x', kind: 'field', field_name: 'weight_g', current_value: 5700, alternate_value: 5800 } as never, 'Europe/Madrid');
    expect(v.question).toContain('peso');
    expect(v.keep).toContain('5,7 kg');
    expect(v.other).toContain('5,8 kg');
  });
});

describe('números escritos en el formulario', () => {
  it('admite coma o punto decimal; vacío es «no medido»; el texto basura se detecta', () => {
    expect(parseDecimal('5,6')).toBe(5.6);
    expect(parseDecimal(' 62.5 ')).toBe(62.5);
    expect(parseDecimal('')).toBeNull();
    expect(Number.isNaN(parseDecimal('cinco'))).toBe(true);
    expect(Number.isNaN(parseDecimal('-3'))).toBe(true);
  });
});
