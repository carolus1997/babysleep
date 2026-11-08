import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import type { DomainError } from '../src/domain/context';
import { composeFeedType, composeSide, finishFeedingAs, getOpenFeeding, startFeeding } from '../src/domain/feeding';
import { makeHarness, MIN } from './harness';

const code = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as DomainError).code);
const babyOf = async (h: Awaited<ReturnType<typeof makeHarness>>) => (await createBaby(h.ctx, { alias: 'Bebé', birthDate: '2026-07-01' })).id;

describe('Terminar toma: qué ha tomado', () => {
  it('compone el tipo: pecho + biberón es «mixta», los sólidos van solos y sin nada no hay tipo', () => {
    expect(composeFeedType({ breast: true, bottle: false, solids: false })).toBe('breast');
    expect(composeFeedType({ breast: false, bottle: true, solids: false })).toBe('bottle');
    expect(composeFeedType({ breast: true, bottle: true, solids: false })).toBe('mixed');
    expect(composeFeedType({ breast: false, bottle: false, solids: true })).toBe('solids');
    expect(composeFeedType({ breast: false, bottle: false, solids: false })).toBeNull();
  });

  it('compone el pecho: los dos lados son «ambos»', () => {
    expect(composeSide(true, true)).toBe('both');
    expect(composeSide(true, false)).toBe('left');
    expect(composeSide(false, true)).toBe('right');
    expect(composeSide(false, false)).toBeNull();
  });

  it('la toma se arranca sin tipo y se cierra con el tipo, el pecho y los ml elegidos', async () => {
    const h = await makeHarness('2027-01-15T10:00');
    const baby = await babyOf(h);
    const f = await startFeeding(h.ctx, baby, 'breast');
    h.advance(14 * MIN);
    const done = await finishFeedingAs(h.ctx, f.id, { type: 'mixed', side: 'left', amountMl: 90 });
    expect(done).toMatchObject({ feed_type: 'mixed', breast_side: 'left', amount_ml: 90, end_quality: 'exact' });
    expect(await getOpenFeeding(h.ctx, baby)).toBeUndefined();
  });

  it('dos pechos se guardan como «ambos» y lo que el tipo no admite se descarta', async () => {
    const h = await makeHarness('2027-01-15T10:00');
    const baby = await babyOf(h);
    const f = await startFeeding(h.ctx, baby, 'breast');
    h.advance(10 * MIN);
    const done = await finishFeedingAs(h.ctx, f.id, { type: 'solids', side: 'both', amountMl: 80 });
    expect(done).toMatchObject({ feed_type: 'solids', breast_side: null, amount_ml: null });
  });

  it('rechaza una cantidad fuera de rango', async () => {
    const h = await makeHarness('2027-01-15T10:00');
    const baby = await babyOf(h);
    const f = await startFeeding(h.ctx, baby, 'breast');
    h.advance(10 * MIN);
    expect(await code(finishFeedingAs(h.ctx, f.id, { type: 'bottle', amountMl: 900 }))).toBe('invalid');
    expect(await getOpenFeeding(h.ctx, baby)).toBeDefined(); // sigue en curso
  });
});
