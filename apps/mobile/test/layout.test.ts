import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('apilamiento de la interfaz (regresión: hojas tapadas por la barra inferior)', () => {
  it('la zona principal no crea un contexto de apilamiento, o las hojas (z-40) quedan bajo la cabecera y la barra (z-30)', () => {
    const app = read('../src/App.tsx');
    const main = /<main className="([^"]*)"/.exec(app)?.[1] ?? '';
    expect(main).not.toBe('');
    expect(main).not.toMatch(/(^|\s)(z-\d+|isolate|transform|will-change|opacity-|backdrop-)/);
  });

  it('las hojas no se pueden arrastrar de lado (con overflow-y: auto, el eje X pasa a auto)', () => {
    const sheet = read('../src/ui/primitives.tsx');
    expect(sheet).toMatch(/overflow-x-hidden/);
    expect(sheet).toMatch(/touch-pan-y/);
  });
});
