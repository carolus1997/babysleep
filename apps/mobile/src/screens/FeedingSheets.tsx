import type { BreastSideT, FeedingT, FeedTypeT } from '@babysleep/contract';
import { parseInstant } from '@babysleep/core';
import { useState, type ReactNode } from 'react';
import { useApp } from '../app/AppContext';
import { addManualFeeding, composeFeedType, composeSide, deleteFeeding, editFeeding, finishFeeding, finishFeedingAs, hasBottle, hasBreast, restoreFeeding, FEED_TYPES } from '../domain/feeding';
import { localToMs } from '../domain/sleep';
import { t, type I18nKey } from '../i18n/es';
import { fmtDur, toLocalInput } from '../ui/format';
import { Icon, type IconName } from '../ui/Icon';
import { Btn, Chip, Field, inputCls, Sheet, Toggle } from '../ui/primitives';
import { TimeField, timeReady, type Choice } from './TimeField';

const SIDES: readonly BreastSideT[] = ['left', 'right', 'both'];
const QUICK_ML = [60, 90, 120, 150];

export const FEED_ICON: Record<FeedTypeT, IconName> = { breast: 'drop', bottle: 'milk', mixed: 'drops', solids: 'solids' };

/** Texto con un icono pequeño al lado: el texto es lo principal, el icono ayuda a reconocerlo de un vistazo. */
export function FeedLabel({ type }: { type: FeedTypeT }) {
  return (
    <>
      <Icon name={FEED_ICON[type]} size={16} className="mr-1.5 inline-block align-[-3px]" />
      {t(`feed.type.${type}` as I18nKey)}
    </>
  );
}

/** Texto del campo de ml → número, `null` si está vacío, NaN si no se entiende (lo rechaza el dominio). */
const toMl = (s: string): number | null => (s.trim() === '' ? null : Number(s.trim().replace(',', '.')));

function SideChips({ value, onChange }: { value: BreastSideT | null; onChange: (v: BreastSideT | null) => void }) {
  return (
    <div className="mb-3" role="group" aria-label={t('feed.side')}>
      <span className="mb-1 block text-sm font-medium text-muted">{t('feed.side')}</span>
      <div className="flex flex-wrap gap-2">
        {SIDES.map((s) => (
          <Chip key={s} active={value === s} onClick={() => onChange(s)}>
            {t(`feed.side.${s}` as I18nKey)}
          </Chip>
        ))}
        <Chip active={value === null} onClick={() => onChange(null)}>
          {t('feed.side.none')}
        </Chip>
      </div>
    </div>
  );
}

function MlField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="mb-3">
      <Field label={t('feed.ml')}>
        <input className={inputCls} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
      <div className="-mt-1 flex flex-wrap gap-2">
        {QUICK_ML.map((ml) => (
          <Chip key={ml} active={value === String(ml)} onClick={() => onChange(String(ml))}>
            {ml}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function TypeChips({ value, onChange }: { value: FeedTypeT; onChange: (v: FeedTypeT) => void }): ReactNode {
  return (
    <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t('feed.type')}>
      {FEED_TYPES.map((ty) => (
        <Chip key={ty} active={value === ty} onClick={() => onChange(ty)}>
          <FeedLabel type={ty} />
        </Chip>
      ))}
    </div>
  );
}

/**
 * «Terminar toma»: se dice qué ha tomado (pecho izquierdo, derecho o los dos; biberón con ml; sólidos), combinable y
 * todo opcional. Cerrar con ✕ NO termina la toma: sigue en curso. «Guardar sin detalles» la termina tal cual.
 */
export function FinishFeedingSheet({ feeding, onClose, onDone }: { feeding: FeedingT; onClose: () => void; onDone: (f: FeedingT) => void }) {
  const { ctx, run } = useApp();
  const [breast, setBreast] = useState(hasBreast(feeding.feed_type));
  const [bottle, setBottle] = useState(hasBottle(feeding.feed_type));
  const [solids, setSolids] = useState(feeding.feed_type === 'solids');
  const [left, setLeft] = useState(feeding.breast_side === 'left' || feeding.breast_side === 'both');
  const [right, setRight] = useState(feeding.breast_side === 'right' || feeding.breast_side === 'both');
  const [ml, setMl] = useState(feeding.amount_ml === null ? '' : String(feeding.amount_ml));
  const type = composeFeedType({ breast, bottle, solids });
  const side = composeSide(left, right);
  const dur = fmtDur(Math.max(0, ctx.now() - parseInstant(feeding.start_utc)));

  const pick = (what: 'breast' | 'bottle' | 'solids') => {
    if (what === 'solids') {
      setSolids(!solids);
      setBreast(false);
      setBottle(false);
      return;
    }
    setSolids(false);
    if (what === 'breast') setBreast(!breast);
    else setBottle(!bottle);
  };

  const mlValue = toMl(ml);
  const summary =
    type === null
      ? null
      : [
          t(`feed.type.${type}` as I18nKey),
          hasBreast(type) && side ? t(`feed.side.${side}` as I18nKey).toLowerCase() : null,
          hasBottle(type) && mlValue ? `${mlValue} ml` : null,
          dur,
        ]
          .filter(Boolean)
          .join(' · ');

  const save = async (details: boolean) => {
    const done = await run(() =>
      details && type !== null
        ? finishFeedingAs(ctx, feeding.id, { type, ...(hasBreast(type) ? { side } : {}), ...(hasBottle(type) ? { amountMl: mlValue } : {}) })
        : finishFeeding(ctx, feeding.id),
    );
    if (done) onDone(done);
  };

  return (
    <Sheet
      title={t('feed.finishTitle')}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-1.5">
          <Btn variant="primary" className="h-12 w-full" disabled={type === null} onClick={() => save(true)}>
            <Icon name="check" size={18} className="mr-2 inline-block align-[-3px]" />
            {t('feed.save')}
          </Btn>
          <Btn variant="ghost" className="w-full" onClick={() => save(false)}>
            {t('feed.saveNoDetails')}
          </Btn>
        </div>
      }
    >
      <p className="-mt-2 mb-3 text-[13px] font-semibold text-muted">{t('feed.finishSub', { dur })}</p>

      <div role="group" aria-label={t('feed.what')}>
        <span className="mb-1.5 block text-[13px] font-bold text-muted">{t('feed.what')}</span>
        <div className="grid grid-cols-3 gap-2">
          <Toggle icon="drop" on={breast} onClick={() => pick('breast')}>
            {t('feed.type.breast')}
          </Toggle>
          <Toggle icon="milk" on={bottle} onClick={() => pick('bottle')}>
            {t('feed.type.bottle')}
          </Toggle>
          <Toggle icon="solids" on={solids} onClick={() => pick('solids')}>
            {t('feed.what.solids')}
          </Toggle>
        </div>
      </div>

      {breast && (
        <div className="mt-3" role="group" aria-label={t('feed.breastWhich')}>
          <span className="mb-1.5 block text-[13px] font-bold text-muted">{t('feed.breastWhich')}</span>
          <div className="grid grid-cols-2 gap-2">
            <Toggle wide on={left} onClick={() => setLeft(!left)}>
              {t('feed.side.left')}
            </Toggle>
            <Toggle wide on={right} onClick={() => setRight(!right)}>
              {t('feed.side.right')}
            </Toggle>
          </div>
        </div>
      )}

      {bottle && (
        <div className="mt-3">
          <MlField value={ml} onChange={setMl} />
        </div>
      )}

      {summary && (
        <p className="mt-3 flex items-center gap-2 rounded-2xl bg-surface2 px-3 py-2.5 text-[13px] font-bold">
          <Icon name="check" size={16} className="text-ok" />
          <span>{t('feed.summaryPrefix', { text: summary })}</span>
        </p>
      )}
    </Sheet>
  );
}

/** Añadir una toma pasada, con su hora local y su duración. */
export function ManualFeedingSheet({ babyId, onClose }: { babyId: string; onClose: () => void }) {
  const { ctx, run } = useApp();
  const [type, setType] = useState<FeedTypeT>('breast');
  const [start, setStart] = useState(toLocalInput(Date.now() - 20 * 60_000, ctx.zone));
  const [sc, setSc] = useState<Choice>(undefined);
  const [minutes, setMinutes] = useState('');
  const [side, setSide] = useState<BreastSideT | null>(null);
  const [ml, setMl] = useState('');
  const ready = timeReady(start, ctx.zone, sc);
  return (
    <Sheet title={t('feed.add')} onClose={onClose}>
      <TypeChips value={type} onChange={setType} />
      <TimeField label={t('session.start')} value={start} onChange={setStart} choice={sc} onChoice={setSc} zone={ctx.zone} />
      <Field label={`${t('feed.duration')} · ${t('feed.optional')}`}>
        <input className={inputCls} inputMode="numeric" placeholder={t('feed.durationUnknown')} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </Field>
      {hasBreast(type) && <SideChips value={side} onChange={setSide} />}
      {hasBottle(type) && <MlField value={ml} onChange={setMl} />}
      <Btn
        variant="primary"
        className="w-full"
        disabled={!ready}
        onClick={async () => {
          const input: Parameters<typeof addManualFeeding>[1] = {
            babyId, type, startLocal: start, durationMin: minutes.trim() === '' ? null : Number(minutes.trim().replace(',', '.')),
            side: hasBreast(type) ? side : null, amountMl: hasBottle(type) ? toMl(ml) : null,
          };
          if (sc !== undefined) input.startChoice = sc;
          if (await run(() => addManualFeeding(ctx, input))) onClose();
        }}
      >
        {t('common.save')}
      </Btn>
    </Sheet>
  );
}

/** Editar una toma: tipo, horas, pecho o ml; notas y eliminar (con deshacer). */
export function FeedingSheet({ feeding, onClose, onNotes }: { feeding: FeedingT; onClose: () => void; onNotes: () => void }) {
  const { ctx, run, toast } = useApp();
  const iStart = toLocalInput(parseInstant(feeding.start_utc), feeding.start_tz);
  const iEnd = feeding.end_utc ? toLocalInput(parseInstant(feeding.end_utc), feeding.end_tz ?? ctx.zone) : '';
  const [type, setType] = useState<FeedTypeT>(feeding.feed_type);
  const [start, setStart] = useState(iStart);
  const [end, setEnd] = useState(iEnd);
  const [sc, setSc] = useState<Choice>(undefined);
  const [ec, setEc] = useState<Choice>(undefined);
  const [side, setSide] = useState<BreastSideT | null>(feeding.breast_side);
  const [ml, setMl] = useState(feeding.amount_ml === null ? '' : String(feeding.amount_ml));
  const ready = timeReady(start, ctx.zone, sc) && (end === '' || timeReady(end, ctx.zone, ec));

  const save = async () => {
    const ok = await run(async () => {
      const patch: Parameters<typeof editFeeding>[2] = {};
      if (type !== feeding.feed_type) patch.type = type;
      if (start !== iStart) patch.startMs = localToMs(start, ctx.zone, sc);
      if (end !== iEnd) patch.endMs = end === '' ? null : localToMs(end, ctx.zone, ec);
      if (hasBreast(type)) patch.side = side;
      if (hasBottle(type)) patch.amountMl = toMl(ml);
      await editFeeding(ctx, feeding.id, patch);
      return true;
    });
    if (ok) onClose();
  };

  return (
    <Sheet title={t('feed.edit')} onClose={onClose}>
      <TypeChips value={type} onChange={setType} />
      <TimeField label={t('session.start')} value={start} onChange={setStart} choice={sc} onChoice={setSc} zone={ctx.zone} />
      <TimeField label={t('session.end')} value={end} onChange={setEnd} choice={ec} onChoice={setEc} zone={ctx.zone} />
      {hasBreast(type) && <SideChips value={side} onChange={setSide} />}
      {hasBottle(type) && <MlField value={ml} onChange={setMl} />}
      <div className="flex flex-col gap-2">
        <Btn variant="primary" disabled={!ready} onClick={save}>
          {t('session.save')}
        </Btn>
        <Btn onClick={onNotes}>{t('home.notes')}</Btn>
        <Btn
          variant="danger"
          onClick={async () => {
            if (await run(async () => (await deleteFeeding(ctx, feeding.id), true))) {
              toast(t('feed.deleted'), { label: t('home.undo'), run: () => void run(() => restoreFeeding(ctx, feeding.id)) });
              onClose();
            }
          }}
        >
          {t('feed.delete')}
        </Btn>
      </div>
    </Sheet>
  );
}
