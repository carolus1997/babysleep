import { CONTRACT_VERSION } from '@babysleep/contract';
import { formatLocal, MS_PER_HOUR, parseInstant, settlingLatency, toIso } from '@babysleep/core';
import { TABLES_FOR_EXPORT } from '../db/schema';
import type { Ctx } from './context';

export const EXPORT_FORMAT = 'babysleep-export';
export const EXPORT_VERSION = 1;
export const BACKUP_REMINDER_DAYS = 7;

export interface ExportFile {
  filename: string;
  mime: string;
  content: string;
}

const stamp = (ctx: Ctx) => toIso(ctx.now()).slice(0, 10);

/** Copia completa (incluidas filas con borrado lógico) para restaurar o migrar. */
export async function buildBackupJson(ctx: Ctx): Promise<ExportFile> {
  const tables: Record<string, unknown[]> = {};
  for (const name of TABLES_FOR_EXPORT) tables[name] = await ctx.db.table(name).toArray();
  const payload = {
    export_format: EXPORT_FORMAT,
    export_version: EXPORT_VERSION,
    contract_version: CONTRACT_VERSION,
    exported_at: toIso(ctx.now()),
    reference_tz: ctx.zone,
    note: 'Instantes en UTC. Las filas con deleted_at no nulo están en la papelera.',
    tables,
  };
  await ctx.db.meta.put({ key: 'last_export_at', value: payload.exported_at });
  return {
    filename: `babysleep-copia-${stamp(ctx)}.json`,
    mime: 'application/json',
    content: JSON.stringify(payload, null, 2),
  };
}

function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const SESSION_CSV_COLUMNS = [
  'session_id',
  'baby',
  'sleep_type',
  'start_local',
  'end_local',
  'start_utc',
  'end_utc',
  'recorded_duration_s',
  'start_tz',
  'end_tz',
  'start_quality',
  'end_quality',
  'type_source',
  'source',
  'awakenings_completeness',
  'settling_started_utc',
  'settling_latency_s',
  'settling_latency_status',
  'deleted',
] as const;

/**
 * Sesiones en CSV (UTF-8 con BOM para Excel). La latencia queda VACÍA cuando es
 * desconocida; nunca se escribe un 0 que no se haya medido.
 */
export async function buildSessionsCsv(ctx: Ctx): Promise<ExportFile> {
  const babies = new Map((await ctx.db.baby.toArray()).map((b) => [b.id, b.alias]));
  const attempts = new Map((await ctx.db.settling_attempt.toArray()).map((a) => [a.id, a]));
  const sessions = (await ctx.db.sleep_session.toArray()).sort((a, b) => a.sleep_start_utc.localeCompare(b.sleep_start_utc));
  const threshold = ((await ctx.db.family.get(ctx.familyId))?.settings.latency_review_threshold_s ?? 3 * 3600) * 1000;

  const lines = [SESSION_CSV_COLUMNS.join(',')];
  for (const s of sessions) {
    const startMs = parseInstant(s.sleep_start_utc);
    const endMs = s.sleep_end_utc === null ? null : parseInstant(s.sleep_end_utc);
    const attempt = s.settling_attempt_id === null ? null : (attempts.get(s.settling_attempt_id) ?? null);
    const lat = settlingLatency(attempt, s, { reviewThresholdMs: threshold || 3 * MS_PER_HOUR });
    lines.push(
      [
        s.id,
        babies.get(s.baby_id) ?? '',
        s.sleep_type,
        formatLocal(startMs, s.start_tz),
        endMs === null || s.end_tz === null ? '' : formatLocal(endMs, s.end_tz),
        s.sleep_start_utc,
        s.sleep_end_utc,
        endMs === null ? '' : Math.round((endMs - startMs) / 1000),
        s.start_tz,
        s.end_tz,
        s.start_quality,
        s.end_quality,
        s.type_source,
        s.source,
        s.awakenings_completeness,
        attempt?.started_utc ?? '',
        lat.status === 'ok' || lat.status === 'needs_review' ? Math.round(lat.ms / 1000) : '',
        lat.status === 'unknown' ? 'unknown' : lat.status === 'anomaly' ? 'anomaly' : lat.status,
        s.deleted_at !== null,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return {
    filename: `babysleep-sesiones-${stamp(ctx)}.csv`,
    mime: 'text/csv;charset=utf-8',
    content: '﻿' + lines.join('\r\n') + '\r\n',
  };
}

/** Sin ninguna copia previa, el aviso espera a que haya datos con 3 días de antigüedad (no molestar el primer día). */
export const FIRST_BACKUP_GRACE_DAYS = 3;

/**
 * ¿Toca recordar la copia manual? Con copias previas: si la última tiene más de 7 días.
 * Sin ninguna copia: cuando el primer registro tiene más de 3 días.
 */
export async function backupReminderDue(ctx: Ctx): Promise<boolean> {
  const first = await ctx.db.sleep_session.orderBy('sleep_start_utc').first();
  if (first === undefined) return false;
  const last = (await ctx.db.meta.get('last_export_at'))?.value as string | undefined;
  if (last === undefined) return ctx.now() - Date.parse(first.created_at) > FIRST_BACKUP_GRACE_DAYS * 24 * MS_PER_HOUR;
  return ctx.now() - Date.parse(last) > BACKUP_REMINDER_DAYS * 24 * MS_PER_HOUR;
}
