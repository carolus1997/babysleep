import { describe, expect, it } from 'vitest';
import { describeConflict, describeValue, listOpenConflicts, resolveConflict, type ConflictRow } from '../src/sync/conflicts';

const ZONE = 'Europe/Madrid';
const row = (over: Partial<ConflictRow>): ConflictRow => ({
  id: 'c1', table_name: 'sleep_session', row_id: 'r1', field_name: null, kind: 'field',
  current_value: null, alternate_value: null, status: 'open', detected_at: '2027-01-15T10:00:00.000Z', ...over,
});

describe('descripción de conflictos para personas', () => {
  it('las horas se muestran en la zona local, no en UTC', () => {
    // 05:10 UTC = 06:10 en Madrid (invierno)
    expect(describeValue('sleep_end_utc', '2027-01-15T05:10:00+00:00', ZONE)).toMatch(/06:10/);
    expect(describeValue('sleep_end_utc', '2027-07-15T05:10:00.000Z', ZONE)).toMatch(/07:10/); // verano: +2
  });

  it('las etiquetas internas se traducen y lo vacío se dice como tal', () => {
    expect(describeValue('sleep_type', 'night', ZONE)).toBe('Noche');
    expect(describeValue('sleep_type', 'nap', ZONE)).toBe('Siesta');
    expect(describeValue('awakenings_completeness', 'partial', ZONE)).toBe('Algunos');
    expect(describeValue('alias', null, ZONE)).toBe('vacío');
    expect(describeValue('alias', 'Lía', ZONE)).toBe('Lía');
  });

  it('el fin de sueño ofrece las dos horas', () => {
    const v = describeConflict(row({ kind: 'end_time', field_name: 'sleep_end_utc', current_value: '2027-01-15T05:00:00+00:00', alternate_value: '2027-01-15T05:10:00+00:00' }), ZONE);
    expect(v.question).toMatch(/hora de despertar distinta/);
    expect(v.keep).toMatch(/^Dejar .*06:00/);
    expect(v.other).toMatch(/^Usar .*06:10/);
  });

  it('un campo cualquiera usa su nombre legible', () => {
    const v = describeConflict(row({ kind: 'field', field_name: 'sleep_type', current_value: 'nap', alternate_value: 'night' }), ZONE);
    expect(v.question).toMatch(/tipo \(siesta o noche\)/);
    expect(v.keep).toBe('Dejar Siesta');
    expect(v.other).toBe('Usar Noche');
  });

  it('un campo desconocido se muestra con su nombre interno, sin romper', () => {
    const v = describeConflict(row({ kind: 'field', field_name: 'campo_raro', current_value: 1, alternate_value: 2 }), ZONE);
    expect(v.question).toMatch(/campo_raro/);
    expect(v.other).toBe('Usar 2');
  });

  it('editar vs borrar explica qué pasó y ofrece mantener o eliminar', () => {
    const a = describeConflict(row({ kind: 'delete_vs_edit' }), ZONE);
    expect(a).toMatchObject({ keep: 'Mantener el registro', other: 'Eliminarlo' });
    const b = describeConflict(row({ kind: 'edit_after_delete' }), ZONE);
    expect(b).toMatchObject({ keep: 'Mantenerlo', other: 'Volver a eliminarlo' });
  });
});

describe('llamadas al servidor', () => {
  const thenable = (rows: unknown[] | null, error: string | null) => {
    const q = {
      filters: [] as unknown[],
      select() { return q; },
      eq(col: string, v: unknown) { q.filters.push([col, v]); return q; },
      order() { return q; },
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: error === null ? null : { message: error } }).then(ok),
    };
    return q;
  };

  it('lista solo los conflictos abiertos', async () => {
    const q = thenable([row({ id: 'a' }), row({ id: 'b' })], null);
    const client = { from: (t: string) => (t === 'sync_conflict' ? q : thenable(null, 'no')) } as never;
    expect((await listOpenConflicts(client)).map((c) => c.id)).toEqual(['a', 'b']);
    expect(q.filters).toEqual([['status', 'open']]);
  });

  it('un error al listar se propaga', async () => {
    const client = { from: () => thenable(null, 'permission denied') } as never;
    await expect(listOpenConflicts(client)).rejects.toThrow(/permission denied/);
  });

  it('resolver envía el id y la decisión, y traduce los errores conocidos', async () => {
    const calls: unknown[] = [];
    const ok = { rpc: (n: string, a: unknown) => (calls.push([n, a]), Promise.resolve({ error: null })) } as never;
    await resolveConflict(ok, 'c1', 'other');
    expect(calls[0]).toEqual(['resolve_conflict', { p_conflict_id: 'c1', p_use: 'other' }]);

    const bad = { rpc: () => Promise.resolve({ error: { message: 'already_resolved' } }) } as never;
    await expect(resolveConflict(bad, 'c1', 'current')).rejects.toThrow(/ya estaba resuelto/);
    const denied = { rpc: () => Promise.resolve({ error: { message: 'not_allowed' } }) } as never;
    await expect(resolveConflict(denied, 'c1', 'current')).rejects.toThrow(/permiso/);
  });
});
