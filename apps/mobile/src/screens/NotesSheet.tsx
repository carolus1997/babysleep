import type { ObservationMomentT, TagT } from '@babysleep/contract';
import { localDate, parseInstant } from '@babysleep/core';
import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext';
import { findObservation, listTags, saveObservation, tagIdsOf, type ObservationTarget } from '../domain/notes';
import { t, type I18nKey } from '../i18n/es';
import { useLive } from '../ui/hooks';
import { Btn, Chip, inputCls, Sheet } from '../ui/primitives';
import { EventDiary, EventSheet } from './EventDiary';

interface Draft {
  text: string;
  tags: Set<string>;
}

const LABEL: Record<ObservationMomentT, I18nKey> = {
  onset: 'notes.onset',
  during: 'notes.during',
  wake: 'notes.wake',
  settling: 'notes.settling',
  feeding: 'notes.feeding',
};

/** Notas y etiquetas rápidas de un momento (al dormirse, durante, al despertar o conciliación). Todo es opcional. */
export function NotesSheet({ target, onClose }: { target: ObservationTarget; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const moments: ObservationMomentT[] = 'sessionId' in target ? ['onset', 'during', 'wake'] : 'attemptId' in target ? ['settling'] : ['feeding'];
  const [drafts, setDrafts] = useState<Partial<Record<ObservationMomentT, Draft>>>({});
  const tags = useLive(() => listTags(ctx), [ctx], [] as TagT[]);
  const [addingEvent, setAddingEvent] = useState(false);
  // La fecha propuesta para un acontecimiento es la del sueño del que se viene (o la de hoy).
  const eventDate = useLive(
    async () => {
      const s = 'sessionId' in target ? await ctx.db.sleep_session.get(target.sessionId) : undefined;
      return localDate(s ? parseInstant(s.sleep_start_utc) : ctx.now(), ctx.zone);
    },
    [ctx],
    localDate(ctx.now(), ctx.zone),
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      const loaded: Partial<Record<ObservationMomentT, Draft>> = {};
      for (const m of moments) {
        const obs = await findObservation(ctx, target, m);
        loaded[m] = { text: obs?.note_text ?? '', tags: new Set(obs ? await tagIdsOf(ctx, obs.id) : []) };
      }
      if (alive) setDrafts(loaded);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  const draftOf = (m: ObservationMomentT): Draft => drafts[m] ?? { text: '', tags: new Set<string>() };
  const patch = (m: ObservationMomentT, d: Draft) => setDrafts((all) => ({ ...all, [m]: d }));

  const save = async () => {
    const ok = await run(async () => {
      for (const m of moments) {
        const d = drafts[m];
        if (d) await saveObservation(ctx, { target, moment: m, text: d.text, tagIds: [...d.tags] });
      }
      return true;
    });
    if (ok) {
      toast(t('common.save') + ' ✓');
      onClose();
    }
  };

  // La hoja del acontecimiento sustituye a esta; lo escrito en las notas se conserva para cuando se vuelva.
  if (addingEvent) return <EventSheet defaultDate={eventDate} onClose={() => setAddingEvent(false)} />;

  return (
    <Sheet title={t('notes.title')} onClose={onClose}>
      <div className="space-y-4">
        {moments.map((m, i) => {
          const draft = draftOf(m);
          const filled = draft.text.trim() !== '' || draft.tags.size > 0;
          return (
            <section key={m} aria-labelledby={`notes-${m}`} className="rounded-2xl border border-line bg-surface2 p-3">
              <h3 id={`notes-${m}`} className="mb-2 flex items-center gap-2 text-base font-bold">
                {moments.length > 1 && (
                  <span className="grid size-6 place-items-center rounded-full bg-accent text-xs text-accent-fg" aria-hidden="true">
                    {i + 1}
                  </span>
                )}
                {t(LABEL[m])}
                {filled && <span className="ml-auto text-xs font-normal text-muted">✓</span>}
              </h3>
              <div className="mb-3 flex flex-wrap gap-2">
                {tags
                  .filter((x) => x.category === m)
                  .map((x) => (
                    <Chip
                      key={x.id}
                      active={draft.tags.has(x.id)}
                      onClick={() => {
                        const next = new Set(draft.tags);
                        if (next.has(x.id)) next.delete(x.id);
                        else next.add(x.id);
                        patch(m, { ...draft, tags: next });
                      }}
                    >
                      {x.label_i18n['es'] ?? x.tag_slug}
                    </Chip>
                  ))}
              </div>
              <textarea
                aria-label={`${t(LABEL[m])}: ${t('notes.free')}`}
                placeholder={t('notes.free')}
                rows={2}
                value={draft.text}
                onChange={(e) => patch(m, { ...draft, text: e.target.value })}
                className={`${inputCls} py-2`}
              />
            </section>
          );
        })}
        <EventDiary onAdd={() => setAddingEvent(true)} />
      </div>
      <p className="my-2 text-sm text-muted">{t('notes.optional')}</p>
      <Btn variant="primary" className="w-full" onClick={save}>
        {t('notes.save')}
      </Btn>
    </Sheet>
  );
}
