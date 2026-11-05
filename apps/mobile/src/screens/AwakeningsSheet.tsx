import type { AwakeningReasonT, AwakeningT, SleepSessionT } from '@babysleep/contract';
import { parseInstant, summarizeAwakenings, buildSpans } from '@babysleep/core';
import { useState } from 'react';
import { useApp } from '../app/AppContext';
import {
  addManualAwakening, AWAKENING_REASONS, awakeningsOf, confirmAwakenings, deleteAwakening, editAwakening, isAwake,
  listAwakenings, restoreAwakening, thresholdMs,
} from '../domain/awakening';
import { localToMs } from '../domain/sleep';
import { t, type I18nKey } from '../i18n/es';
import { fmtClock, fmtDur, toLocalInput } from '../ui/format';
import { useLive } from '../ui/hooks';
import { Btn, Chip, Field, inputCls, Sheet } from '../ui/primitives';
import { TimeField, timeReady, type Choice } from './TimeField';

export const reasonLabel = (r: AwakeningReasonT | null): string => (r === null ? t('awake.noReason') : t(`awake.reason.${r}` as I18nKey));

function ReasonChips({ value, onChange }: { value: AwakeningReasonT | null; onChange: (v: AwakeningReasonT | null) => void }) {
  return (
    <div className="mb-3" role="group" aria-label={t('awake.reason')}>
      <span className="mb-1 block text-sm font-medium text-muted">{t('awake.reason')}</span>
      <div className="flex flex-wrap gap-2">
        {AWAKENING_REASONS.map((r) => (
          <Chip key={r} active={value === r} onClick={() => onChange(value === r ? null : r)}>
            {reasonLabel(r)}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/** Añadir o editar un despertar. El fin / la duración es opcional: sin ella no se descuenta nada. */
function AwakeningForm({ session, awakening, onDone }: { session: SleepSessionT; awakening: AwakeningT | null; onDone: () => void }) {
  const { ctx, run, toast } = useApp();
  const startIso = awakening?.start_utc ?? null;
  const iStart = startIso === null ? toLocalInput(Math.min(ctx.now(), session.sleep_end_utc ? parseInstant(session.sleep_end_utc) - 1 : ctx.now()), ctx.zone) : toLocalInput(parseInstant(startIso), awakening?.start_tz ?? ctx.zone);
  const iEnd = awakening?.end_utc ? toLocalInput(parseInstant(awakening.end_utc), awakening.end_tz ?? ctx.zone) : '';
  const [start, setStart] = useState(iStart);
  const [end, setEnd] = useState(iEnd);
  const [minutes, setMinutes] = useState('');
  const [sc, setSc] = useState<Choice>(undefined);
  const [ec, setEc] = useState<Choice>(undefined);
  const [reason, setReason] = useState<AwakeningReasonT | null>(awakening?.reason ?? null);
  const ready = timeReady(start, ctx.zone, sc) && (end === '' || timeReady(end, ctx.zone, ec));

  const save = async () => {
    const ok = await run(async () => {
      if (awakening === null) {
        const input: Parameters<typeof addManualAwakening>[1] = {
          sessionId: session.id,
          startLocal: start,
          durationMin: minutes.trim() === '' ? null : Number(minutes.trim().replace(',', '.')),
          reason,
        };
        if (sc !== undefined) input.startChoice = sc;
        await addManualAwakening(ctx, input);
      } else {
        const patch: Parameters<typeof editAwakening>[2] = { reason };
        if (start !== iStart) patch.startMs = localToMs(start, ctx.zone, sc);
        if (end !== iEnd) patch.endMs = end === '' ? null : localToMs(end, ctx.zone, ec);
        await editAwakening(ctx, awakening.id, patch);
      }
      return true;
    });
    if (ok) onDone();
  };

  return (
    <>
      <TimeField label={t('awake.start')} value={start} onChange={setStart} choice={sc} onChoice={setSc} zone={ctx.zone} />
      {awakening === null ? (
        <Field label={`${t('awake.duration')} · ${t('feed.optional')}`}>
          <input className={inputCls} inputMode="numeric" placeholder={t('awake.unknownDur')} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </Field>
      ) : (
        <TimeField label={`${t('awake.end')} · ${t('feed.optional')}`} value={end} onChange={setEnd} choice={ec} onChoice={setEc} zone={ctx.zone} />
      )}
      <ReasonChips value={reason} onChange={setReason} />
      <div className="flex flex-col gap-2">
        <Btn variant="primary" disabled={!ready} onClick={save}>
          {t('common.save')}
        </Btn>
        {awakening !== null && (
          <Btn
            variant="danger"
            onClick={async () => {
              if (await run(async () => (await deleteAwakening(ctx, awakening.id), true))) {
                toast(t('awake.deleted'), { label: t('home.undo'), run: () => void run(() => restoreAwakening(ctx, awakening.id)) });
                onDone();
              }
            }}
          >
            {t('awake.delete')}
          </Btn>
        )}
        <Btn variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Btn>
      </div>
    </>
  );
}

/** Despertares de UNA noche: lista, resumen con el descuento, alta/edición y «estos son todos». */
export function AwakeningsSheet({ session, onClose }: { session: SleepSessionT; onClose: () => void }) {
  const { ctx, baby, run } = useApp();
  const all = useLive(() => listAwakenings(ctx, session.baby_id), [ctx, session.baby_id], [] as AwakeningT[]);
  const live = useLive(() => ctx.db.sleep_session.get(session.id), [ctx, session.id], session) ?? session;
  const [mode, setMode] = useState<'list' | { edit: AwakeningT | null }>('list');
  const mine = awakeningsOf(all, session.id);
  const thr = thresholdMs(baby ?? undefined);
  const now = ctx.now();
  const spans = buildSpans([live], { nowMs: now }).spans;
  const sum = summarizeAwakenings(spans, mine, thr, now);
  const complete = live.awakenings_completeness === 'complete';

  return (
    <Sheet title={t('awake.title')} onClose={onClose}>
      {mode !== 'list' ? (
        <AwakeningForm session={live} awakening={mode.edit} onDone={() => setMode('list')} />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            {t('awake.summary', { n: sum.count, long: sum.longCount, thr: Math.round(thr / 60_000), dur: fmtDur(sum.awakeMs) })}
          </p>
          {mine.length === 0 ? (
            <p className="mb-3 text-sm text-muted">{t('awake.none')}</p>
          ) : (
            <ul className="mb-3 divide-y divide-line">
              {mine.map((a) => {
                const start = parseInstant(a.start_utc);
                const end = a.end_utc ? parseInstant(a.end_utc) : null;
                const dur = end === null ? (isAwake(a) ? now - start : null) : end - start;
                const long = dur !== null && dur >= thr;
                return (
                  <li key={a.id}>
                    <button className="flex min-h-14 w-full items-center justify-between gap-2 py-2 text-left" onClick={() => setMode({ edit: a })}>
                      <span>
                        <span className="font-medium">{fmtClock(start, a.start_tz)}</span>
                        <span className="ml-2 rounded-full bg-surface2 px-2 py-0.5 text-xs">{reasonLabel(a.reason)}</span>
                        {long && <span className="ml-1 rounded-full bg-surface2 px-2 py-0.5 text-xs font-semibold">{t('awake.long')}</span>}
                      </span>
                      <span className="font-semibold">
                        {dur === null ? <span className="text-sm font-normal text-muted">{t('awake.unknownDur')}</span> : fmtDur(dur)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-col gap-2">
            <Btn variant="primary" onClick={() => setMode({ edit: null })}>
              + {t('awake.add')}
            </Btn>
            <Btn
              variant={complete ? 'secondary' : 'ghost'}
              aria-pressed={complete}
              onClick={() => void run(() => confirmAwakenings(ctx, session.id, !complete))}
            >
              {complete ? '✓ ' : ''}
              {t('awake.all')}
            </Btn>
            <p className="text-xs text-muted">{t('awake.allHint')}</p>
          </div>
        </>
      )}
    </Sheet>
  );
}
