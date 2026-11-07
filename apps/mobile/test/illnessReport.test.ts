import { describe, expect, it } from 'vitest';
import { createBaby, renameBaby } from '../src/domain/bootstrap';
import { listFeedings, startFeeding, finishFeeding } from '../src/domain/feeding';
import { addEntry, listEntries, listEpisodes, startEpisode } from '../src/domain/illness';
import { addDose, addMedication, listDoses, listMedications } from '../src/domain/medication';
import { addManualSession, listSessions } from '../src/domain/sleep';
import { buildIllnessReport } from '../src/ui/illnessReport';
import { reportToHtml, reportToText } from '../src/ui/report';
import { HOUR, makeHarness } from './harness';

const setup = async () => {
  const h = await makeHarness('2027-01-24T12:00');
  const baby = await createBaby(h.ctx, { alias: 'Luna', birthDate: '2026-09-01' });
  return { h, baby };
};

const build = async (h: Awaited<ReturnType<typeof setup>>['h'], babyId: string, episodeId: string) => {
  const baby = (await h.ctx.db.baby.get(babyId))!;
  const episode = (await listEpisodes(h.ctx, babyId)).find((e) => e.id === episodeId)!;
  return buildIllnessReport({
    baby,
    episode,
    entries: (await listEntries(h.ctx, babyId)).filter((e) => e.episode_id === episodeId),
    medications: await listMedications(h.ctx, babyId),
    doses: await listDoses(h.ctx, babyId),
    sessions: await listSessions(h.ctx, babyId),
    feedings: await listFeedings(h.ctx, babyId),
    awakenings: [],
    awakeningThresholdMs: 30 * 60_000,
    zone: h.ctx.zone,
    nowMs: h.nowMs(),
  });
};

describe('informe del episodio de enfermedad', () => {
  it('reúne temperatura, síntomas, comida, pañales, medicación con horas y notas; solo hechos', async () => {
    const { h, baby } = await setup();
    await renameBaby(h.ctx, baby.id, { cipa: 'TEST0000000000' });
    const ep = await startEpisode(h.ctx, { babyId: baby.id, title: 'Resfriado de prueba', startLocal: '2027-01-20T20:00', notes: 'Empezó con mocos' });
    const at = (local: string) => Date.parse(`${local}:00+01:00`);
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'temperature', tempDc: 372, site: 'axillary', atMs: at('2027-01-20T21:00') });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'temperature', tempDc: 391, site: 'rectal', atMs: at('2027-01-21T03:00'), note: 'Llorosa' });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'temperature', tempDc: 384, atMs: at('2027-01-22T09:00') });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'symptom', symptom: 'cough', atMs: at('2027-01-20T22:00') });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'symptom', symptom: 'cough', atMs: at('2027-01-22T10:00') });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'symptom', symptom: 'runny_nose', atMs: at('2027-01-20T20:30'), note: 'transparentes' });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'intake', intake: 'less', atMs: at('2027-01-21T12:00') });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'diaper', diaper: 'wet', atMs: at('2027-01-21T12:10') });
    await addEntry(h.ctx, { episodeId: ep.id, kind: 'note', note: 'Durmió inquieta', atMs: at('2027-01-21T07:00') });
    const m = await addMedication(h.ctx, { babyId: baby.id, name: 'Medicamento de prueba', doseText: '2,5 ml', intervalMin: 360, startLocal: '2027-01-20T18:00' });
    await addDose(h.ctx, { medicationId: m.id, atMs: at('2027-01-21T03:10'), confirmed: true });
    await addDose(h.ctx, { medicationId: m.id, atMs: at('2027-01-21T09:30'), doseText: '2 ml', confirmed: true });
    await addDose(h.ctx, { medicationId: m.id, atMs: at('2027-01-10T09:30'), confirmed: true }); // antes del episodio: no sale
    const f = await startFeeding(h.ctx, baby.id, 'bottle');
    h.advance(10 * 60_000);
    await finishFeeding(h.ctx, f.id, { amountMl: 90 });

    const text = reportToText(await build(h, baby.id, ep.id));
    expect(text).toContain('Informe del episodio · Luna');
    expect(text).toContain('Resfriado de prueba');
    expect(text).toContain('en curso');
    expect(text).toContain('3 medidas anotadas');
    expect(text).toMatch(/Más alta: .*39,1 °C \(recto\)/);
    expect(text).toMatch(/Más baja: .*37,2 °C \(axila\)/);
    expect(text).toMatch(/Primera: .*37,2 °C/);
    expect(text).toMatch(/Última: .*38,4 °C/);
    expect(text).toMatch(/Tos: 2 anotaciones/);
    expect(text).toMatch(/Mocos: 1 anotación /);
    expect(text).toContain('menos de lo habitual 1');
    expect(text).toContain('Pañales anotados: pis 1, caca 0, pis y caca 0');
    expect(text).toMatch(/Medicamento de prueba · 2,5 ml/);
    expect(text).toMatch(/Medicamento de prueba · 2 ml/);
    expect(text).toContain('Pauta anotada de Medicamento de prueba: 2,5 ml, cada 6 h');
    expect((text.match(/· Medicamento de prueba · /g) ?? []).length).toBe(2); // la dosis del día 10 no entra
    expect(text).toContain('Notas del episodio: Empezó con mocos');
    expect(text).toContain('Durmió inquieta');
    expect(text).toContain('transparentes');
    expect(text).toContain('Llorosa');
    expect(text).toContain('Anotaciones del episodio: 9');
    // solo hechos: ni «fiebre», ni «normal», ni diagnóstico; y el CIPA no sale nunca
    expect(text).not.toMatch(/fiebre|anormal|grave|diagn[oó]stic[ao] de/i);
    expect(text).not.toContain('TEST0000000000');
    expect(text).toContain('No es un diagnóstico');
  });

  it('sin anotaciones lo dice, nunca pone ceros inventados', async () => {
    const { h, baby } = await setup();
    const ep = await startEpisode(h.ctx, { babyId: baby.id });
    const text = reportToText(await build(h, baby.id, ep.id));
    expect(text).toContain('Sin temperaturas anotadas');
    expect(text).toContain('Sin síntomas anotados');
    expect(text).toContain('Sin anotaciones sobre cuánto comió');
    expect(text).toContain('Sin pañales anotados');
    expect(text).toContain('Sin dosis anotadas durante el episodio');
    expect(text).toContain('Sin notas');
    expect(text).toContain('Sin días completos con datos suficientes para comparar');
  });

  it('compara los días completos del episodio con los 7 anteriores, con su n; con menos de 3 días con datos avisa', async () => {
    const { h, baby } = await setup();
    for (const d of ['13', '14', '15', '16', '17', '18', '19']) {
      await addManualSession(h.ctx, { babyId: baby.id, startLocal: `2027-01-${d}T10:00`, endLocal: `2027-01-${d}T11:30`, type: 'nap' });
    }
    const ep = await startEpisode(h.ctx, { babyId: baby.id, startLocal: '2027-01-20T20:00' });
    // días completos del episodio: 21, 22 y 23. Solo hay datos de dos.
    for (const d of ['21', '22']) {
      await addManualSession(h.ctx, { babyId: baby.id, startLocal: `2027-01-${d}T10:00`, endLocal: `2027-01-${d}T13:00`, type: 'nap' });
    }
    const text = reportToText(await build(h, baby.id, ep.id));
    expect(text).toContain('Sueño total por día: antes 1 h 30 min (n=7) · durante 3 h 0 min (n=2)');
    expect(text).toContain('menos de 3 días completos con datos durante el episodio: no se comparan');
    expect(text).toContain('no dice qué causó los cambios');
    h.advance(HOUR); // el informe no depende de que pase el tiempo dentro del mismo día
    expect(reportToText(await build(h, baby.id, ep.id))).toContain('Sueño total por día');
  });

  it('el HTML es autónomo y escapa el nombre', async () => {
    const { h, baby } = await setup();
    await renameBaby(h.ctx, baby.id, { alias: '<b>"X"</b>' });
    const ep = await startEpisode(h.ctx, { babyId: baby.id, title: '<script>alert(1)</script>' });
    const html = reportToHtml(await build(h, baby.id, ep.id));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>"X"</b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toMatch(/src=|href=/);
  });
});
