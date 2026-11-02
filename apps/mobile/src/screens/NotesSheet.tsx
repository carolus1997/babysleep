import type { ObservationMomentT, TagT } from '@babysleep/contract';
import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext';
import { findObservation, listTags, saveObservation, tagIdsOf, type ObservationTarget } from '../domain/notes';
import { t, type I18nKey } from '../i18n/es';
import { useLive } from '../ui/hooks';
import { Btn, Chip, inputCls, Sheet } from '../ui/primitives';

interface Draft {
  text: string;
  tags: Set<string>;
}

const LABEL: Record<ObservationMomentT, I18nKey> = {
  onset: 'notes.onset',
  during: 'notes.during',
  wake: 'notes.wake',
  settling: 'notes.settling',
};

/** Notas y etiquetas rápidas de un momento (al dormirse, durante, al despertar o conciliación). Todo es opcional. */
export function NotesSheet({ target, onClose }: { target: ObservationTarget; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const moments: ObservationMomentT[] = 'sessionId' in target ? ['onset', 'during', 'wake'] : ['settling'];
  const [moment, setMoment] = useState<ObservationMomentT>(moments[0] as ObservationMomentT);
  const [drafts, setDrafts] = useState<Partial<Record<ObservationMomentT, Draft>>>({});
  const tags = useLive(() => listTags(ctx), [ctx], [] as TagT[]);

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

  const draft = drafts[moment] ?? { text: '', tags: new Set<string>() };
  const patch = (d: Draft) => setDrafts((all) => ({ ...all, [moment]: d }));

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

  return (
    <Sheet title={t('notes.title')} onClose={onClose}>
      {moments.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-2" role="tablist">
          {moments.map((m) => (
            <Chip key={m} active={m === moment} role="tab" onClick={() => setMoment(m)}>
              {t(LABEL[m])}
            </Chip>
          ))}
        </div>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        {tags
          .filter((x) => x.category === moment)
          .map((x) => (
            <Chip
              key={x.id}
              active={draft.tags.has(x.id)}
              onClick={() => {
                const next = new Set(draft.tags);
                if (next.has(x.id)) next.delete(x.id);
                else next.add(x.id);
                patch({ ...draft, tags: next });
              }}
            >
              {x.label_i18n['es'] ?? x.tag_slug}
            </Chip>
          ))}
      </div>
      <textarea
        aria-label={t('notes.free')}
        placeholder={t('notes.free')}
        rows={3}
        value={draft.text}
        onChange={(e) => patch({ ...draft, text: e.target.value })}
        className={`${inputCls} py-2`}
      />
      <p className="my-2 text-sm text-muted">{t('notes.optional')}</p>
      <Btn variant="primary" className="w-full" onClick={save}>
        {t('notes.save')}
      </Btn>
    </Sheet>
  );
}
