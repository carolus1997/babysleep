import type { EventCategoryT, LifeEventT } from '@babysleep/contract';
import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { addLifeEvent, deleteLifeEvent, listLifeEvents } from '../domain/notes';
import { t } from '../i18n/es';
import { useLive } from '../ui/hooks';
import { Icon } from '../ui/Icon';
import { Btn, Field, inputCls, Sheet } from '../ui/primitives';

/** Alta de un acontecimiento (guardería, dientes, enfermedad, cambio de rutina…). */
export function EventSheet({ defaultDate, onClose }: { defaultDate: string; onClose: () => void }) {
  const { ctx, baby, run, toast } = useApp();
  const cats = useLive(() => ctx.db.event_category.toArray(), [ctx], [] as EventCategoryT[]);
  const [cat, setCat] = useState('');
  const [start, setStart] = useState(defaultDate);
  const [end, setEnd] = useState('');
  const [desc, setDesc] = useState('');
  const [all, setAll] = useState(false);
  const categoryId = cat || cats[0]?.id || '';
  return (
    <Sheet title={t('settings.addEvent')} onClose={onClose}>
      <Field label={t('event.category')}>
        <select className={inputCls} value={categoryId} onChange={(e) => setCat(e.target.value)}>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label_i18n['es']}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('event.start')}>
        <input className={inputCls} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </Field>
      <Field label={t('event.end')}>
        <input className={inputCls} type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
      </Field>
      <Field label={t('event.description')}>
        <input className={inputCls} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      <label className="mb-4 flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        {t('event.allFamily')}
      </label>
      <Btn
        variant="primary"
        className="w-full"
        disabled={!categoryId || !start}
        onClick={async () => {
          const ok = await run(() =>
            addLifeEvent(ctx, { babyId: all ? null : (baby?.id ?? null), categoryId, startDate: start, endDate: end || null, description: desc }),
          );
          if (ok) {
            toast(t('event.saved'));
            onClose();
          }
        }}
      >
        {t('event.save')}
      </Btn>
    </Sheet>
  );
}

/** El diario de acontecimientos del bebé, dentro de «Info adicional»: alta y lista de lo anotado. */
export function EventDiary({ onAdd }: { onAdd: () => void }) {
  const { ctx, baby, run } = useApp();
  const events = useLive(() => (baby ? listLifeEvents(ctx, baby.id) : Promise.resolve([])), [ctx, baby?.id], [] as LifeEventT[]);
  const cats = useLive(() => ctx.db.event_category.toArray(), [ctx], [] as EventCategoryT[]);
  const sorted = [...events].sort((a, b) => b.start_date.localeCompare(a.start_date));
  return (
    <section aria-label={t('settings.diary')} className="rounded-2xl border border-line bg-surface2 p-3">
      <h3 className="text-base font-bold">{t('settings.diary')}</h3>
      <p className="mb-2 text-sm text-muted">{t('event.help')}</p>
      <Btn className="w-full bg-surface!" onClick={onAdd}>
        + {t('settings.addEvent')}
      </Btn>
      {sorted.length > 0 && (
        <details className="mt-2">
          <summary className="min-h-11 cursor-pointer content-center text-sm font-bold">{t('event.list', { n: sorted.length })}</summary>
          <ul className="divide-y divide-line">
            {sorted.map((e) => (
              <li key={e.id} className="flex min-h-12 items-center justify-between gap-2 text-sm">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <strong>{cats.find((c) => c.id === e.category_id)?.label_i18n['es']}</strong> · {e.start_date}
                  {e.end_date ? ` → ${e.end_date}` : ''}
                  {e.description ? ` · ${e.description}` : ''}
                </span>
                <Btn variant="ghost" aria-label={t('common.delete')} onClick={() => run(() => deleteLifeEvent(ctx, e.id))}>
                  <Icon name="close" size={18} />
                </Btn>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
