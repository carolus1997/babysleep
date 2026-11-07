import type { BabySleepDb } from '../db/schema';

/** Contexto de ejecución de cualquier operación de dominio. */
export interface Ctx {
  db: BabySleepDb;
  /** Reloj inyectable (ms desde la época); en pruebas es determinista. */
  now: () => number;
  /** Zona IANA de referencia (`family.home_tz`). */
  zone: string;
  familyId: string;
  caregiverId: string;
  deviceId: string;
}

export class DomainError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_range'
      | 'already_open'
      | 'ambiguous_time'
      | 'nonexistent_time'
      | 'needs_confirmation'
      | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
