import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { listFeedings } from '../src/domain/feeding';
import { addManualSession, listSessions } from '../src/domain/sleep';
import { buildReport, reportToHtml, reportToText } from '../src/ui/report';
import { makeHarness } from './harness';

describe('informe semanal', () => {
  it('con datos da cifras con su n; sin datos dice «sin datos» y nunca inventa ceros', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'Luna', birthDate: '2026-09-01' });
    const input = async () => ({
      baby,
      sessions: await listSessions(h.ctx, baby.id),
      feedings: await listFeedings(h.ctx, baby.id),
      awakenings: [],
      awakeningThresholdMs: 30 * 60_000,
      zone: h.ctx.zone,
      nowMs: h.nowMs(),
    });

    const empty = reportToText(buildReport(await input()));
    expect(empty).toContain('Resumen semanal de Luna');
    expect(empty).toContain('sin datos');
    expect(empty).toContain('Sin tomas anotadas');
    expect(empty).not.toMatch(/Sueño medio por día: 0/);

    for (const d of ['2027-01-15', '2027-01-16', '2027-01-17']) {
      await addManualSession(h.ctx, { babyId: baby.id, startLocal: `${d}T10:00`, endLocal: `${d}T11:30`, type: 'nap' });
    }
    const txt = reportToText(buildReport(await input()));
    expect(txt).toContain('Días completos con datos: 3 de 7');
    expect(txt).toContain('Sueño medio por día: 1 h 30 min');
    expect(txt).toContain('Descansos cerrados: 3; con horas aproximadas: 3');
  });

  it('el HTML es autónomo y escapa el nombre', async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: '<b>"X"</b>', birthDate: '2026-09-01' });
    const html = reportToHtml(
      buildReport({ baby, sessions: [], feedings: [], awakenings: [], awakeningThresholdMs: 1_800_000, zone: h.ctx.zone, nowMs: h.nowMs() }),
    );
    expect(html).not.toContain('<b>"X"</b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toMatch(/<script|src=|href=/);
  });
});
