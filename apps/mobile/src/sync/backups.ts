import type { AppClient } from './supabase';

/** Los cuatro estados de las copias (spec §8). Distintos y no intercambiables. */
export interface BackupStatus {
  last_backup_created_at: string | null;
  last_backup_stored_at: string | null;
  last_technical_restore_at: string | null;
  last_full_recovery_drill_at: string | null;
}

export interface BackupHealth {
  level: 'none' | 'ok' | 'warn';
  headline: string;
  lines: string[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Una copia diaria que lleva más de esto sin almacenarse es un problema. */
const STALE_MS = 36 * HOUR;
/** El simulacro con clave real se pide cada ~3 meses. */
const DRILL_MS = 100 * DAY;

/** Solo los administradores pueden leerlo; para el resto no hay fila y no se muestra nada. */
export async function getBackupStatus(client: AppClient): Promise<BackupStatus | null> {
  const { data, error } = await client.from('backup_status').select('*').limit(1);
  if (error !== null) throw new Error(error.message);
  return ((data ?? [])[0] as BackupStatus | undefined) ?? null;
}

export function ago(iso: string | null, nowMs: number): string {
  if (iso === null) return 'nunca';
  const d = nowMs - Date.parse(iso);
  if (d < HOUR) return 'hace menos de una hora';
  if (d < DAY) return `hace ${Math.floor(d / HOUR)} h`;
  const days = Math.floor(d / DAY);
  return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

/**
 * Resume el estado de las copias en lenguaje llano. Una copia que no se ha restaurado nunca no cuenta como
 * copia, y el estado «almacenada» es el que dice si hay algo a salvo.
 */
export function backupHealth(s: BackupStatus, nowMs: number): BackupHealth {
  const lines = [
    `Copia almacenada: ${ago(s.last_backup_stored_at, nowMs)}`,
    `Restauración de prueba: ${ago(s.last_technical_restore_at, nowMs)}`,
    `Simulacro con clave real: ${ago(s.last_full_recovery_drill_at, nowMs)}`,
  ];
  if (s.last_backup_created_at === null && s.last_backup_stored_at === null) {
    return {
      level: 'none',
      headline: 'Aún no hay copias automáticas. Hoy el único seguro es la copia JSON manual.',
      lines: ['Guía: ops/backups/README.md'],
    };
  }
  const problems: string[] = [];
  if (s.last_backup_stored_at === null || nowMs - Date.parse(s.last_backup_stored_at) > STALE_MS) {
    problems.push('La última copia almacenada es antigua: revisa el trabajo diario en GitHub Actions.');
  }
  if (s.last_technical_restore_at === null) problems.push('Ninguna copia se ha restaurado de prueba todavía.');
  if (s.last_full_recovery_drill_at === null || nowMs - Date.parse(s.last_full_recovery_drill_at) > DRILL_MS) {
    problems.push('Toca hacer el simulacro de recuperación con una clave real (cada ~3 meses).');
  }
  return problems.length === 0
    ? { level: 'ok', headline: 'Las copias están al día.', lines }
    : { level: 'warn', headline: problems[0] as string, lines: [...problems.slice(1), ...lines] };
}
