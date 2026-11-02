import type { SleepSessionT } from '@babysleep/contract';
import { parseInstant, recordedDurationMs } from '@babysleep/core';
import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { addManualSession, deleteSession, editSession, localToMs, restoreSession } from '../domain/sleep';
import { t } from '../i18n/es';
import { fmtDur, toLocalInput } from '../ui/format';
import { Btn, Card, Chip, Sheet } from '../ui/primitives';
import { TimeField, timeReady, type Choice } from './TimeField';

const TYPES = ['nap', 'night'] as const;

export function SessionSheet({ session, onClose, onNotes }: { session: SleepSessionT; onClose: () => void; onNotes: () => void }) {
  const { ctx, run, toast } = useApp();
  const initialStart = toLocalInput(parseInstant(session.sleep_start_utc), session.start_tz);
  const initialEnd = session.sleep_end_utc ? toLocalInput(parseInstant(session.sleep_end_utc), session.end_tz ?? ctx.zone) : '';
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [sc, setSc] = useState<Choice>(undefined);
  const [ec, setEc] = useState<Choice>(undefined);
  const [type, setType] = useState(session.sleep_type);
  const dur = recordedDurationMs(session);

  const ready = timeReady(start, ctx.zone, sc) && (end === '' || timeReady(end, ctx.zone, ec));

  const save = async () => {
    const ok = await run(async () => {
      const patch: Parameters<typeof editSession>[2] = {};
      if (start !== initialStart) patch.startMs = localToMs(start, ctx.zone, sc);
      if (end !== initialEnd) patch.endMs = end === '' ? null : localToMs(end, ctx.zone, ec);
      if (type !== session.sleep_type) patch.type = type;
      if (Object.keys(patch).length > 0) await editSession(ctx, session.id, patch);
      return true;
    });
    if (ok) onClose();
  };

  return (
    <Sheet title={t('session.edit')} onClose={onClose}>
      {dur !== null && (
        <p className="mb-1 text-center text-3xl font-bold">{fmtDur(dur)}</p>
      )}
      <p className="mb-4 text-center text-xs text-muted">{t('session.durationHint')}</p>
      <div className="mb-3 flex gap-2">
        {TYPES.map((ty) => (
          <Chip key={ty} active={type === ty} onClick={() => setType(ty)}>
            {t(ty === 'nap' ? 'home.type.nap' : 'home.type.night')}
          </Chip>
        ))}
      </div>
      <TimeField label={t('session.start')} value={start} onChange={setStart} choice={sc} onChoice={setSc} zone={ctx.zone} />
      <TimeField label={t('session.end')} value={end} onChange={setEnd} choice={ec} onChoice={setEc} zone={ctx.zone} />
      <div className="flex flex-col gap-2">
        <Btn variant="primary" disabled={!ready} onClick={save}>
          {t('session.save')}
        </Btn>
        <Btn onClick={onNotes}>{t('home.notes')}</Btn>
        <Btn
          variant="danger"
          onClick={async () => {
            await run(() => deleteSession(ctx, session.id));
            toast(t('session.delete') + ' ✓', { label: t('home.undo'), run: () => void run(() => restoreSession(ctx, session.id)) });
            onClose();
          }}
        >
          {t('session.delete')}
        </Btn>
      </div>
    </Sheet>
  );
}

export function ManualSheet({ babyId, onClose }: { babyId: string; onClose: () => void }) {
  const { ctx, run } = useApp();
  const now = Date.now();
  const [type, setType] = useState<'nap' | 'night'>('nap');
  const [start, setStart] = useState(toLocalInput(now - 3_600_000, ctx.zone));
  const [end, setEnd] = useState(toLocalInput(now, ctx.zone));
  const [sc, setSc] = useState<Choice>(undefined);
  const [ec, setEc] = useState<Choice>(undefined);
  const ready = timeReady(start, ctx.zone, sc) && timeReady(end, ctx.zone, ec);

  return (
    <Sheet title={t('history.add')} onClose={onClose}>
      <Card className="mb-3">
        <div className="flex gap-2">
          {TYPES.map((ty) => (
            <Chip key={ty} active={type === ty} onClick={() => setType(ty)}>
              {t(ty === 'nap' ? 'home.type.nap' : 'home.type.night')}
            </Chip>
          ))}
        </div>
      </Card>
      <TimeField label={t('session.start')} value={start} onChange={setStart} choice={sc} onChoice={setSc} zone={ctx.zone} />
      <TimeField label={t('session.end')} value={end} onChange={setEnd} choice={ec} onChoice={setEc} zone={ctx.zone} />
      <Btn
        variant="primary"
        className="w-full"
        disabled={!ready}
        onClick={async () => {
          const input: Parameters<typeof addManualSession>[1] = { babyId, startLocal: start, endLocal: end, type };
          if (sc !== undefined) input.startChoice = sc;
          if (ec !== undefined) input.endChoice = ec;
          const ok = await run(() => addManualSession(ctx, input));
          if (ok) onClose();
        }}
      >
        {t('common.save')}
      </Btn>
    </Sheet>
  );
}
