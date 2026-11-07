import type { GrowthMeasureT } from '@babysleep/contract';
import {
  CURVE_PERCENTILES,
  GROWTH_KINDS,
  growthChanges,
  localDate,
  referenceCurves,
  WHO_SOURCE,
  type GrowthKind,
  type GrowthPoint,
} from '@babysleep/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { addGrowth, deleteGrowth, editGrowth, listGrowth, pointsFor, restoreGrowth } from '../domain/growth';
import { t, type I18nKey } from '../i18n/es';
import { useLive } from '../ui/hooks';
import { Btn, Card, Chip, Field, inputCls, Sheet } from '../ui/primitives';

const KIND_KEY: Record<GrowthKind, I18nKey> = { weight: 'growth.kind.weight', length: 'growth.kind.length', head: 'growth.kind.head' };
const UNIT: Record<GrowthKind, string> = { weight: 'kg', length: 'cm', head: 'cm' };
const DAYS_PER_MONTH = 30.4375;

const fmtDate = (d: string): string => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
const fmtValue = (kind: GrowthKind, v: number): string => `${v.toLocaleString('es-ES', { minimumFractionDigits: kind === 'weight' ? 2 : 1, maximumFractionDigits: kind === 'weight' ? 3 : 1 })} ${UNIT[kind]}`;
const fmtPct = (p: number): string => (p < 1 ? '<1' : p > 99 ? '>99' : String(Math.round(p)));
const fmtAge = (days: number): string => {
  const m = Math.floor(days / DAYS_PER_MONTH);
  const d = Math.round(days - m * DAYS_PER_MONTH);
  return m === 0 ? t('growth.ageDays', { d: days }) : t('growth.ageMonths', { m, d });
};

/** «5,6» o «5.6» → 5.6; vacío → null; texto inválido → NaN. */
export function parseDecimal(s: string): number | null {
  const x = s.trim().replace(',', '.');
  if (x === '') return null;
  return /^\d+(\.\d+)?$/.test(x) ? Number(x) : Number.NaN;
}

const fieldOf = (v: number | null, div: number): string => (v === null ? '' : String(v / div).replace('.', ','));

// ------------------------------------------------------------------ gráfica

function Chart({ kind, points }: { kind: GrowthKind; points: GrowthPoint[] }) {
  const W = 320;
  const H = 220;
  const pad = { l: 36, r: 8, t: 8, b: 22 };
  const own = points.filter((p) => p.kind === kind);
  const lastAge = Math.max(0, ...own.map((p) => p.ageDays));
  const toDays = Math.max(180, Math.ceil((lastAge + 60) / 30.4375 / 3) * 3 * 30.4375);
  const set = referenceCurves(kind, 0, toDays, 7);
  const ys = [...own.map((p) => p.value), ...(set?.curves.flatMap((c) => c.points.map((q) => q[1])) ?? [])];
  const lo = ys.length ? Math.min(...ys) : 0;
  const hi = ys.length ? Math.max(...ys) : 1;
  const span = hi - lo || 1;
  const yMin = lo - span * 0.05;
  const yMax = hi + span * 0.05;
  const x = (d: number) => pad.l + (d / toDays) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - ((v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const monthStep = toDays / DAYS_PER_MONTH > 24 ? 12 : toDays / DAYS_PER_MONTH > 12 ? 3 : 1;
  const xTicks: number[] = [];
  for (let m = 0; m * DAYS_PER_MONTH <= toDays + 1; m += monthStep) xTicks.push(m);
  const yTicks = [0, 1, 2, 3, 4].map((i) => yMin + ((yMax - yMin) * i) / 4);
  const path = (pts: Array<[number, number]>) => pts.map(([d, v], i) => `${i === 0 ? 'M' : 'L'}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t('growth.chartLabel', { kind: t(KIND_KEY[kind]) })}>
      <g className="text-muted" fontSize="9" fill="currentColor">
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity="0.15" />
            <text x={pad.l - 4} y={y(v) + 3} textAnchor="end">
              {v.toLocaleString('es-ES', { maximumFractionDigits: kind === 'weight' ? 1 : 0 })}
            </text>
          </g>
        ))}
        {xTicks.map((m) => (
          <text key={m} x={x(m * DAYS_PER_MONTH)} y={H - 6} textAnchor="middle">
            {m}
          </text>
        ))}
        <text x={1} y={H - 6} textAnchor="start" opacity="0.8">
          {t('growth.axisMonths')}
        </text>
      </g>
      {set?.curves.map((c) => (
        <g key={c.percentile} className="text-muted">
          <path d={path(c.points)} fill="none" stroke="currentColor" strokeWidth={c.percentile === 50 ? 1.6 : 1} strokeDasharray={c.percentile === 50 ? undefined : '3 3'} opacity={c.percentile === 50 ? 0.8 : 0.55} />
          <text x={x(c.points[c.points.length - 1]![0]) - 2} y={y(c.points[c.points.length - 1]![1]) - 2} textAnchor="end" fontSize="8" fill="currentColor">
            {c.percentile}
          </text>
        </g>
      ))}
      <g className="text-accent">
        {own.length > 1 && <path d={path(own.map((p) => [p.ageDays, p.value]))} fill="none" stroke="currentColor" strokeWidth="1.5" />}
        {own.map((p) => (
          <circle key={`${p.on}`} cx={x(p.ageDays)} cy={y(p.value)} r="4" fill="currentColor" stroke="white" strokeWidth="1" />
        ))}
      </g>
    </svg>
  );
}

// ------------------------------------------------------------------ hoja

function GrowthSheet({ babyId, edit, onClose }: { babyId: string; edit: GrowthMeasureT | null; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const [on, setOn] = useState(edit?.measured_on ?? localDate(ctx.now(), ctx.zone));
  const [w, setW] = useState(fieldOf(edit?.weight_g ?? null, 1000));
  const [l, setL] = useState(fieldOf(edit?.length_mm ?? null, 10));
  const [h, setH] = useState(fieldOf(edit?.head_mm ?? null, 10));
  const [place, setPlace] = useState(edit?.place ?? '');
  const [notes, setNotes] = useState(edit?.notes ?? '');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const pw = parseDecimal(w);
    const pl = parseDecimal(l);
    const ph = parseDecimal(h);
    if ([pw, pl, ph].some((v) => v !== null && Number.isNaN(v))) {
      setErr(t('growth.badNumber'));
      return;
    }
    const weightG = pw === null ? null : Math.round(pw * 1000);
    const lengthMm = pl === null ? null : Math.round(pl * 10);
    const headMm = ph === null ? null : Math.round(ph * 10);
    const done = await run(async () => {
      if (edit) await editGrowth(ctx, edit.id, { measuredOn: on, weightG, lengthMm, headMm, place, notes });
      else await addGrowth(ctx, { babyId, measuredOn: on, weightG, lengthMm, headMm, place, notes });
      return true;
    });
    if (done) {
      toast(t('growth.saved'));
      onClose();
    }
  };
  return (
    <Sheet title={edit ? t('growth.edit') : t('growth.new')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('growth.date')}>
          <input type="date" className={inputCls} value={on} max={localDate(ctx.now(), ctx.zone)} onChange={(e) => setOn(e.target.value)} />
        </Field>
        <Field label={t('growth.weightKg')}>
          <input inputMode="decimal" className={inputCls} value={w} onChange={(e) => setW(e.target.value)} placeholder="5,60" />
        </Field>
        <Field label={t('growth.lengthCm')}>
          <input inputMode="decimal" className={inputCls} value={l} onChange={(e) => setL(e.target.value)} placeholder="62,5" />
        </Field>
        <Field label={t('growth.headCm')}>
          <input inputMode="decimal" className={inputCls} value={h} onChange={(e) => setH(e.target.value)} placeholder="40,5" />
        </Field>
        <p className="text-xs text-muted">{t('growth.optionalHint')}</p>
        <Field label={t('growth.place')}>
          <input className={inputCls} value={place} onChange={(e) => setPlace(e.target.value)} maxLength={160} />
        </Field>
        <Field label={t('growth.notes')}>
          <textarea className={`${inputCls} py-2`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </Field>
        {err && <p className="text-sm text-danger">{err}</p>}
        <Btn variant="primary" className="w-full" onClick={() => void save()}>
          {t('common.save')}
        </Btn>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ pantalla

/** Crecimiento: medidas anotadas sobre las curvas de la OMS (niñas). Solo hechos; la interpretación es del pediatra. */
export function Growth() {
  const { ctx, baby, run, toast } = useApp();
  const babyId = baby?.id ?? '';
  const rows = useLive(() => listGrowth(ctx, babyId), [ctx, babyId], [] as GrowthMeasureT[]);
  const [kind, setKind] = useState<GrowthKind>('weight');
  const [sheet, setSheet] = useState<{ edit: GrowthMeasureT | null } | null>(null);
  const points = useMemo(() => (baby ? pointsFor(baby, rows) : []), [baby, rows]);
  const own = points.filter((p) => p.kind === kind);
  const last = own[own.length - 1];
  const change = useMemo(() => growthChanges(points).filter((c) => c.kind === kind).pop(), [points, kind]);
  if (baby === null) return null;
  const remove = async (g: GrowthMeasureT) => {
    if (await run(async () => (await deleteGrowth(ctx, g.id), true))) toast(t('growth.removed'), { label: t('home.undo'), run: () => void run(() => restoreGrowth(ctx, g.id)) });
  };
  const hasRef = last?.percentile !== null && last?.percentile !== undefined;
  return (
    <div className="space-y-4">
      <Btn variant="primary" className="w-full" onClick={() => setSheet({ edit: null })}>
        + {t('growth.new')}
      </Btn>
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('growth.kind')}>
        {GROWTH_KINDS.map((k) => (
          <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
            {t(KIND_KEY[k])}
          </Chip>
        ))}
      </div>

      {own.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">{t('growth.empty')}</p>
        </Card>
      ) : (
        <Card title={t(KIND_KEY[kind])}>
          <p className="text-2xl font-bold">{fmtValue(kind, last!.value)}</p>
          <p className="text-sm text-muted">
            {fmtDate(last!.on)} · {last!.corrected ? t('growth.correctedAge', { age: fmtAge(last!.ageDays) }) : fmtAge(last!.ageDays)}
          </p>
          {hasRef ? (
            <p className="mt-1 text-sm">{t('growth.percentile', { p: fmtPct(last!.percentile!), z: last!.z!.toLocaleString('es-ES', { maximumFractionDigits: 2, signDisplay: 'exceptZero' }) })}</p>
          ) : (
            <p className="mt-1 text-sm text-muted">{kind === 'length' ? t('growth.noLengthRef') : t('growth.outOfRange')}</p>
          )}
          {change && (
            <p className="mt-1 text-sm text-muted">
              {t('growth.change', {
                delta: `${change.delta > 0 ? '+' : ''}${change.delta.toLocaleString('es-ES', { maximumFractionDigits: kind === 'weight' ? 3 : 1 })} ${UNIT[kind]}`,
                days: change.days,
              })}
              {change.percentileChange !== null && ` · ${t('growth.pctFromTo', { a: fmtPct(change.from.percentile!), b: fmtPct(change.to.percentile!) })}`}
            </p>
          )}
        </Card>
      )}

      <Card>
        <Chart kind={kind} points={points} />
        <p className="mt-1 text-xs text-muted">{t('growth.chartHint', { list: CURVE_PERCENTILES.join(', ') })}</p>
      </Card>

      {rows.length > 0 && (
        <Card title={t('growth.visits')}>
          <ul className="divide-y divide-line">
            {[...rows].reverse().map((g) => (
              <li key={g.id} className="py-2">
                <p className="font-semibold">{fmtDate(g.measured_on)}</p>
                <p className="text-sm">
                  {[g.weight_g !== null && fmtValue('weight', g.weight_g / 1000), g.length_mm !== null && fmtValue('length', g.length_mm / 10), g.head_mm !== null && fmtValue('head', g.head_mm / 10)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {g.place && <p className="text-xs text-muted">{g.place}</p>}
                {g.notes && <p className="whitespace-pre-wrap text-xs text-muted">{g.notes}</p>}
                <div className="mt-1 flex gap-2">
                  <Btn variant="ghost" className="min-h-10 px-3 text-sm" onClick={() => setSheet({ edit: g })}>
                    {t('common.edit')}
                  </Btn>
                  <Btn variant="danger" className="min-h-10 px-3 text-sm" onClick={() => void remove(g)}>
                    {t('common.delete')}
                  </Btn>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-xs text-muted">
        {t('growth.source')}{' '}
        <a className="underline" href={WHO_SOURCE.url} target="_blank" rel="noreferrer">
          {WHO_SOURCE.name}
        </a>
      </p>
      <p className="text-xs text-muted">{t('growth.disclaimer')}</p>

      {sheet && <GrowthSheet babyId={baby.id} edit={sheet.edit} onClose={() => setSheet(null)} />}
    </div>
  );
}
