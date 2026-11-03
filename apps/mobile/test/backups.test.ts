import { describe, expect, it } from 'vitest';
import { ago, backupHealth, getBackupStatus, type BackupStatus } from '../src/sync/backups';

const NOW = Date.parse('2027-03-10T12:00:00.000Z');
const h = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const status = (over: Partial<BackupStatus> = {}): BackupStatus => ({
  last_backup_created_at: h(9), last_backup_stored_at: h(9), last_technical_restore_at: h(9), last_full_recovery_drill_at: h(24 * 30), ...over,
});

describe('estado de las copias', () => {
  it('sin ninguna copia lo dice claro y recuerda que solo existe la manual', () => {
    const r = backupHealth(status({ last_backup_created_at: null, last_backup_stored_at: null, last_technical_restore_at: null, last_full_recovery_drill_at: null }), NOW);
    expect(r.level).toBe('none');
    expect(r.headline).toMatch(/JSON manual/);
  });

  it('todo reciente: al día', () => {
    expect(backupHealth(status(), NOW)).toMatchObject({ level: 'ok', headline: 'Las copias están al día.' });
  });

  it('una copia almacenada de hace más de 36 h es una alerta', () => {
    const r = backupHealth(status({ last_backup_stored_at: h(40) }), NOW);
    expect(r.level).toBe('warn');
    expect(r.headline).toMatch(/antigua/);
  });

  it('creada pero nunca almacenada NO cuenta como copia', () => {
    const r = backupHealth(status({ last_backup_stored_at: null }), NOW);
    expect(r.level).toBe('warn');
    expect(r.headline).toMatch(/antigua/);
  });

  it('sin restauración de prueba o sin simulacro reciente también avisa', () => {
    expect(backupHealth(status({ last_technical_restore_at: null }), NOW).headline).toMatch(/restaurado de prueba/);
    const drill = backupHealth(status({ last_full_recovery_drill_at: h(24 * 120) }), NOW);
    expect(drill.level).toBe('warn');
    expect(drill.headline).toMatch(/simulacro/);
    expect(backupHealth(status({ last_full_recovery_drill_at: null }), NOW).level).toBe('warn');
  });

  it('los tiempos relativos están en español', () => {
    expect(ago(null, NOW)).toBe('nunca');
    expect(ago(h(0.2), NOW)).toBe('hace menos de una hora');
    expect(ago(h(5), NOW)).toBe('hace 5 h');
    expect(ago(h(24), NOW)).toBe('hace 1 día');
    expect(ago(h(24 * 3), NOW)).toBe('hace 3 días');
  });

  it('para quien no es administrador no hay fila y no se muestra nada', async () => {
    const q = { select: () => q, limit: () => q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok) };
    expect(await getBackupStatus({ from: () => q } as never)).toBeNull();
  });
});
