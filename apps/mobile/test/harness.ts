import 'fake-indexeddb/auto';
import { mustResolveLocal } from '@babysleep/core';
import { BabySleepDb } from '../src/db/schema';
import { ensureBootstrap } from '../src/domain/bootstrap';
import type { Ctx } from '../src/domain/context';

export const MADRID = 'Europe/Madrid';
export const MIN = 60_000;
export const HOUR = 3_600_000;

let counter = 0;

export interface Harness {
  ctx: Ctx;
  /** Fija el reloj en una hora local de Madrid. */
  at(local: string): void;
  advance(ms: number): void;
  nowMs(): number;
}

/** Contexto aislado con IndexedDB falso y reloj controlable. */
export async function makeHarness(startLocal = '2027-01-15T13:00'): Promise<Harness> {
  let t = mustResolveLocal(startLocal, MADRID);
  const db = new BabySleepDb(`test-${++counter}-${Math.random().toString(36).slice(2)}`);
  const ctx = await ensureBootstrap(db, () => t);
  return {
    ctx,
    at: (local) => {
      t = mustResolveLocal(local, MADRID);
    },
    advance: (ms) => {
      t += ms;
    },
    nowMs: () => t,
  };
}
