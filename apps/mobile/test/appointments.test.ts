import { describe, expect, it } from 'vitest';
import {
  buildAppointmentPayload,
  leadText,
  whenText,
  type DueAppointmentReminder,
} from '../../../supabase/functions/feed-reminders/payload';
import {
  addAppointment,
  DEFAULT_REMINDERS,
  deleteAppointment,
  editAppointment,
  listAppointments,
  normalizeReminders,
  past,
  restoreAppointment,
  setAppointmentStatus,
  upcoming,
} from '../src/domain/appointments';
import { createBaby } from '../src/domain/bootstrap';
import { DomainError } from '../src/domain/context';
import { buildBackupJson } from '../src/domain/export';
import { applyImport, planImport } from '../src/domain/import';
import { mergeBabies } from '../src/domain/merge';
import { makeHarness } from './harness';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof DomainError ? e.code : 'other';
  }
};

describe('citas', () => {
  const setup = async () => {
    const h = await makeHarness('2027-01-20T12:00');
    const baby = await createBaby(h.ctx, { alias: 'B', birthDate: '2026-09-01' });
    return { h, baby };
  };

  it('crea una cita con la hora local de la familia y los avisos por defecto (1 día y 1 h antes)', async () => {
    const { h, baby } = await setup();
    const a = await addAppointment(h.ctx, { babyId: baby.id, kind: 'pediatrician', title: '  Revisión de los 4 meses ', startLocal: '2027-02-01T09:30', place: ' Centro de prueba ' });
    expect(a).toMatchObject({ title: 'Revisión de los 4 meses', status: 'scheduled', place: 'Centro de prueba', start_utc: '2027-02-01T08:30:00.000Z', start_tz: 'Europe/Madrid', duration_min: null });
    expect(a.remind_before_min).toEqual([...DEFAULT_REMINDERS]);
  });

  it('valida el título, la duración y los avisos; una hora que no existe se rechaza', async () => {
    const { h, baby } = await setup();
    const add = (over: object) => code(addAppointment(h.ctx, { babyId: baby.id, kind: 'other', title: 'X', startLocal: '2027-02-01T09:30', ...over }));
    expect(await add({ title: '  ' })).toBe('invalid');
    expect(await add({ durationMin: 2 })).toBe('invalid');
    expect(await add({ remindBeforeMin: [60, 120, 180, 240, 300, 360] })).toBe('invalid');
    expect(await add({ remindBeforeMin: [50_000] })).toBe('invalid');
    expect(await add({ remindBeforeMin: [-1] })).toBe('invalid');
    expect(await add({ startLocal: '2027-03-28T02:30' })).toBe('nonexistent_time'); // salto de hora en Madrid
    expect(await add({})).toBeNull();
  });

  it('normaliza los avisos: sin repetidos y de mayor a menor antelación', () => {
    expect(normalizeReminders([60, 1440, 60, 0])).toEqual([1440, 60, 0]);
    expect(normalizeReminders([])).toEqual([]);
  });

  it('edita, marca como hecha o cancelada, elimina y restaura', async () => {
    const { h, baby } = await setup();
    const a = await addAppointment(h.ctx, { babyId: baby.id, kind: 'test', title: 'Análisis', startLocal: '2027-02-01T09:30' });
    const e = await editAppointment(h.ctx, a.id, { startLocal: '2027-02-02T10:00', title: 'Análisis de sangre', remindBeforeMin: [120], notes: '' });
    expect(e).toMatchObject({ start_utc: '2027-02-02T09:00:00.000Z', title: 'Análisis de sangre', remind_before_min: [120], notes: null });
    expect((await setAppointmentStatus(h.ctx, a.id, 'done')).status).toBe('done');
    await deleteAppointment(h.ctx, a.id);
    expect(await listAppointments(h.ctx, baby.id)).toEqual([]);
    await restoreAppointment(h.ctx, a.id);
    expect((await listAppointments(h.ctx, baby.id)).map((x) => x.id)).toEqual([a.id]);
  });

  it('separa próximas y pasadas; la cita que empezó hace menos de 1 h aún cuenta como próxima', async () => {
    const { h, baby } = await setup();
    const now = h.nowMs(); // 2027-01-20 12:00 local
    const mk = (start: string, title: string) => addAppointment(h.ctx, { babyId: baby.id, kind: 'other', title, startLocal: start });
    const soon = await mk('2027-01-21T09:00', 'Mañana');
    const justStarted = await mk('2027-01-20T11:30', 'Empezó hace 30 min');
    const old = await mk('2027-01-10T09:00', 'Vieja');
    const done = await mk('2027-02-10T09:00', 'Hecha');
    await setAppointmentStatus(h.ctx, done.id, 'done');
    const all = await listAppointments(h.ctx, baby.id);
    expect(upcoming(all, now).map((a) => a.id)).toEqual([justStarted.id, soon.id]);
    expect(past(all, now).map((a) => a.id)).toEqual([done.id, old.id]);
  });

  it('al fusionar dos perfiles las citas pasan al que se conserva', async () => {
    const { h, baby } = await setup();
    const other = await createBaby(h.ctx, { alias: 'Duplicado', birthDate: '2026-09-01' });
    await addAppointment(h.ctx, { babyId: other.id, kind: 'other', title: 'Cita', startLocal: '2027-02-01T09:30' });
    await mergeBabies(h.ctx, other.id, baby.id);
    expect((await listAppointments(h.ctx, baby.id)).map((a) => a.title)).toEqual(['Cita']);
    expect(await listAppointments(h.ctx, other.id)).toEqual([]);
  });

  it('entran en la copia JSON y se restauran en un dispositivo nuevo', async () => {
    const { h, baby } = await setup();
    await addAppointment(h.ctx, { babyId: baby.id, kind: 'pediatrician', title: 'Revisión', startLocal: '2027-02-01T09:30', remindBeforeMin: [1440, 60] });
    const backup = await buildBackupJson(h.ctx);
    const b = await makeHarness('2027-03-01T10:00');
    const plan = await planImport(b.ctx, backup.content);
    expect(plan.ok, plan.errors.join(' | ')).toBe(true);
    expect(plan.toAdd.appointment).toHaveLength(1);
    await applyImport(b.ctx, plan);
    const nb = (await b.ctx.db.baby.toArray())[0]!;
    expect(await listAppointments(b.ctx, nb.id)).toMatchObject([{ title: 'Revisión', remind_before_min: [1440, 60] }]);
  });
});

describe('texto de los avisos', () => {
  const due = (over: Partial<DueAppointmentReminder> = {}): DueAppointmentReminder => ({
    subscription_id: 's',
    endpoint: 'https://push.example.test/x',
    p256dh: 'k',
    auth: 'a',
    appointment_id: '0190a1b2-0000-7000-8000-000000000001',
    baby_id: 'b1',
    baby_alias: 'Luna',
    title: 'Revisión de los 4 meses',
    kind: 'pediatrician',
    start_utc: '2027-02-01T08:30:00.000Z',
    start_tz: 'Europe/Madrid',
    place: 'Centro de prueba',
    minutes_before: 60,
    ...over,
  });

  it('dice cuándo es respecto al aviso', () => {
    expect(leadText(0)).toBe('ahora');
    expect(leadText(30)).toBe('en 30 min');
    expect(leadText(60)).toBe('en 1 h');
    expect(leadText(120)).toBe('en 2 h');
    expect(leadText(1440)).toBe('mañana');
    expect(leadText(2880)).toBe('en 2 días');
    expect(leadText(10080)).toBe('en 7 días');
  });

  it('la hora sale en la zona en que se anotó la cita, no en la del servidor', () => {
    expect(whenText('2027-02-01T08:30:00.000Z', 'Europe/Madrid')).toContain('09:30');
    expect(whenText('2027-02-01T08:30:00.000Z', 'America/Mexico_City')).toContain('02:30');
    expect(whenText('2027-02-01T08:30:00.000Z', 'Zona/Inventada')).toContain('09:30'); // zona desconocida: Madrid
  });

  it('el aviso lleva título, hora, lugar y bebé, sin botones de toma, y uno distinto por antelación', () => {
    const p = buildAppointmentPayload(due());
    expect(p).toMatchObject({ title: 'Cita en 1 h · Luna', kind: 'appointment', url: './?go=health', babyId: 'b1' });
    expect(p.body).toContain('Revisión de los 4 meses');
    expect(p.body).toContain('09:30');
    expect(p.body).toContain('Centro de prueba');
    expect(buildAppointmentPayload(due({ minutes_before: 1440 })).tag).not.toBe(p.tag);
    expect(buildAppointmentPayload(due({ place: null })).body).not.toContain(' · ');
  });
});
