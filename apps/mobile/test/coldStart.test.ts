import { describe, expect, it } from 'vitest';
import { isColdStart, RESUME_WINDOW_MS } from '../src/app/coldStart';

const NOW = 1_800_000_000_000;
const base = { lastActiveMs: NOW - 60 * 60_000, nowMs: NOW, navigationType: 'navigate', wasDiscarded: false };

describe('arranque en frío frente a volver a la app', () => {
  it('primer uso (sin actividad guardada): bienvenida', () => {
    expect(isColdStart({ ...base, lastActiveMs: null })).toBe(true);
  });

  it('abierta de nuevo mucho después de la última actividad: bienvenida y elección de bebé', () => {
    expect(isColdStart(base)).toBe(true);
    expect(isColdStart({ ...base, lastActiveMs: NOW - RESUME_WINDOW_MS - 1 })).toBe(true);
  });

  it('volver tras mirar otra app (poco después de la última actividad): sin bienvenida', () => {
    expect(isColdStart({ ...base, lastActiveMs: NOW - 30_000 })).toBe(false);
    expect(isColdStart({ ...base, lastActiveMs: NOW - RESUME_WINDOW_MS })).toBe(false);
  });

  it('una recarga o la restauración del historial no son «abrir la app»', () => {
    expect(isColdStart({ ...base, navigationType: 'reload' })).toBe(false);
    expect(isColdStart({ ...base, navigationType: 'back_forward' })).toBe(false);
  });

  it('una pestaña que el navegador descartó en segundo plano vuelve sin bienvenida, aunque haya pasado mucho', () => {
    expect(isColdStart({ ...base, wasDiscarded: true })).toBe(false);
  });

  it('con el reloj cambiado (la última actividad en el futuro) se prefiere la bienvenida', () => {
    expect(isColdStart({ ...base, lastActiveMs: NOW + 60_000 })).toBe(true);
  });
});
