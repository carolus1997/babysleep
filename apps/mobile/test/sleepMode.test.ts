import { describe, expect, it } from 'vitest';
import { createBaby } from '../src/domain/bootstrap';
import { findObservation, tagIdsOf } from '../src/domain/notes';
import { getOpenAttempt, getOpenSession, startSettlingWith, startSleepWith } from '../src/domain/sleep';
import { clearIntent, loadIntent, loadLastOnset, ONSET_FROM_SETTLING, saveIntent, saveLastOnset, SETTLING_CHIP_SLUGS, SETTLING_FROM_ONSET, SLEEP_HOW_SLUGS } from '../src/domain/sleepIntent';
import { SEED_TAGS } from '../src/domain/seed';
import { HOUR, makeHarness, MIN } from './harness';

const babyOf = async (h: Awaited<ReturnType<typeof makeHarness>>) => (await createBaby(h.ctx, { alias: 'Bebé', birthDate: '2026-07-01' })).id;
const tagId = async (h: Awaited<ReturnType<typeof makeHarness>>, slug: string) => (await h.ctx.db.tag.toArray()).find((t) => t.tag_slug === slug)?.id as string;

/** Almacén en memoria con la forma de localStorage. */
const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('modo de sueño', () => {
  it('todas las formas de dormirse que se ofrecen existen en el catálogo, y «En porteo» también al conciliar', () => {
    const slugs = new Set(SEED_TAGS.map((t) => t.slug));
    for (const s of SLEEP_HOW_SLUGS) expect(slugs.has(s), s).toBe(true);
    for (const [onset, settling] of Object.entries(SETTLING_FROM_ONSET)) {
      expect(slugs.has(onset)).toBe(true);
      expect(slugs.has(settling), settling).toBe(true);
    }
    expect(SLEEP_HOW_SLUGS).toContain('onset.babywearing');
    expect(slugs.has('settling.babywearing')).toBe(true);
  });

  it('«Ya duerme» deja lo elegido explícito: tipo manual, aunque coincida con la sugerencia, y etiquetas de «al dormirse»', async () => {
    const h = await makeHarness('2027-01-15T10:40'); // por la hora se sugiere siesta
    const baby = await babyOf(h);
    const porteo = await tagId(h, 'onset.babywearing');
    const s = await startSleepWith(h.ctx, baby, { type: 'nap', onsetTagIds: [porteo] });
    expect(s).toMatchObject({ sleep_type: 'nap', type_source: 'manual', sleep_end_utc: null });
    const obs = await findObservation(h.ctx, { sessionId: s.id }, 'onset');
    expect(obs).toBeDefined();
    expect(await tagIdsOf(h.ctx, (obs as { id: string }).id)).toEqual([porteo]);
  });

  it('se puede elegir noche por la tarde-noche o siesta aunque la hora sugiera noche (ya no se decide solo)', async () => {
    const h = await makeHarness('2027-01-15T21:10'); // por la hora se sugiere noche
    const baby = await babyOf(h);
    const s = await startSleepWith(h.ctx, baby, { type: 'nap', onsetTagIds: [] });
    expect(s.sleep_type).toBe('nap');
    expect(await findObservation(h.ctx, { sessionId: s.id }, 'onset')).toBeUndefined(); // sin etiquetas, sin observación
  });

  it('si ya hay un sueño abierto, no se toca', async () => {
    const h = await makeHarness('2027-01-15T10:40');
    const baby = await babyOf(h);
    const first = await startSleepWith(h.ctx, baby, { type: 'nap', onsetTagIds: [] });
    h.advance(5 * MIN);
    const again = await startSleepWith(h.ctx, baby, { type: 'night', onsetTagIds: [] });
    expect(again.id).toBe(first.id);
    expect(again.sleep_type).toBe('nap');
  });

  it('«Prepararlo para dormir» abre el intento con la forma elegida, y «Ya duerme» lo enlaza al sueño', async () => {
    const h = await makeHarness('2027-01-15T10:30');
    const baby = await babyOf(h);
    const porteoSettling = await tagId(h, 'settling.babywearing');
    const a = await startSettlingWith(h.ctx, baby, { settlingTagIds: [porteoSettling] });
    expect((await getOpenAttempt(h.ctx, baby))?.id).toBe(a.id);
    const obs = await findObservation(h.ctx, { attemptId: a.id }, 'settling');
    expect(await tagIdsOf(h.ctx, (obs as { id: string }).id)).toEqual([porteoSettling]);

    h.advance(8 * MIN);
    const s = await startSleepWith(h.ctx, baby, { type: 'nap', onsetTagIds: [await tagId(h, 'onset.babywearing')] });
    expect(s.settling_attempt_id).toBe(a.id);
    expect((await getOpenSession(h.ctx, baby))?.id).toBe(s.id);
    void HOUR;
  });
});

describe('etiquetas de la preparación', () => {
  it('todas las que se ofrecen al preparar existen en el catálogo, y lo que ayudó vuelve a ser «cómo se durmió»', () => {
    const slugs = new Set(SEED_TAGS.map((t) => t.slug));
    for (const s of SETTLING_CHIP_SLUGS) expect(slugs.has(s), s).toBe(true);
    for (const [settling, onset] of Object.entries(ONSET_FROM_SETTLING)) {
      expect(SETTLING_FROM_ONSET[onset]).toBe(settling);
      expect(SLEEP_HOW_SLUGS).toContain(onset);
    }
    expect(ONSET_FROM_SETTLING['settling.babywearing']).toBe('onset.babywearing');
  });
});

describe('elección pendiente y recuerdo local', () => {
  it('recuerda cómo se durmió la última vez y descarta lo que ya no se ofrece', () => {
    const s = memStore();
    expect(loadLastOnset(s)).toEqual([]);
    saveLastOnset(['onset.babywearing', 'onset.in_car', 'onset.ya_no_existe'], s);
    expect(loadLastOnset(s)).toEqual(['onset.babywearing', 'onset.in_car']);
  });

  it('la elección pendiente solo vale para su intento y se puede borrar', () => {
    const s = memStore();
    saveIntent({ attemptId: 'a1', type: 'nap', onsetSlugs: ['onset.babywearing'] }, s);
    expect(loadIntent('a1', s)).toEqual({ attemptId: 'a1', type: 'nap', onsetSlugs: ['onset.babywearing'] });
    expect(loadIntent('otro', s)).toBeNull();
    clearIntent(s);
    expect(loadIntent('a1', s)).toBeNull();
  });

  it('con datos estropeados o sin almacenamiento no falla', () => {
    const bad = { getItem: () => '{no es json', setItem: () => {}, removeItem: () => {} };
    expect(loadLastOnset(bad)).toEqual([]);
    expect(loadIntent('a1', bad)).toBeNull();
    expect(loadLastOnset(null)).toEqual([]);
    expect(() => saveIntent({ attemptId: 'a', type: 'night', onsetSlugs: [] }, null)).not.toThrow();
  });
});
