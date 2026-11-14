import type { TagT } from '@babysleep/contract';
import { suggestSleepType } from '@babysleep/core';
import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { listTags } from '../domain/notes';
import { startSettlingWith, startSleepWith } from '../domain/sleep';
import { loadLastOnset, saveIntent, saveLastOnset, SETTLING_FROM_ONSET, SLEEP_HOW_SLUGS } from '../domain/sleepIntent';
import { t } from '../i18n/es';
import { fmtClock } from '../ui/format';
import { useLive } from '../ui/hooks';
import { Icon } from '../ui/Icon';
import { Btn, Chip, Sheet, Toggle } from '../ui/primitives';

/**
 * «Dormir» ya no empieza a contar a ciegas: primero se elige el modo de sueño (siesta o noche, sugerido por la hora
 * pero a la vista) y, si se quiere, cómo se duerme (en brazos, porteo, cuna…, recordando la última vez). Después,
 * «Ya duerme» inicia el sueño y «Prepararlo para dormir» inicia la preparación, que pasa a sueño con «Ya duerme».
 * Diseño: docs/design/prototypes (vista «Tomas y sueño» y «Revisión UX»).
 */
export function SleepModeSheet({ babyId, onClose }: { babyId: string; onClose: () => void }) {
  const { ctx, run } = useApp();
  const tags = useLive(() => listTags(ctx), [ctx], [] as TagT[]);
  const nowMs = ctx.now();
  const suggested = suggestSleepType(nowMs, ctx.zone);
  const [type, setType] = useState<'nap' | 'night'>(suggested);
  const [how, setHow] = useState<string[]>(() => loadLastOnset());
  const remembered = loadLastOnset().length > 0;

  const tagOf = (slug: string, category: 'onset' | 'settling') => tags.find((x) => x.tag_slug === slug && x.category === category);
  const options = SLEEP_HOW_SLUGS.map((slug) => tagOf(slug, 'onset')).filter((x): x is TagT => x !== undefined);
  const toggle = (slug: string) => setHow((cur) => (cur.includes(slug) ? cur.filter((x) => x !== slug) : [...cur, slug]));

  const asleep = async () => {
    const ok = await run(async () => {
      const onsetTagIds = how.map((s) => tagOf(s, 'onset')?.id).filter((x): x is string => x !== undefined);
      await startSleepWith(ctx, babyId, { type, onsetTagIds });
      return true;
    });
    if (ok) {
      saveLastOnset(how);
      onClose();
    }
  };

  const prepare = async () => {
    const ok = await run(async () => {
      const settlingTagIds = how
        .map((s) => SETTLING_FROM_ONSET[s])
        .map((s) => (s === undefined ? undefined : tagOf(s, 'settling')?.id))
        .filter((x): x is string => x !== undefined);
      const attempt = await startSettlingWith(ctx, babyId, { settlingTagIds });
      saveIntent({ attemptId: attempt.id, type, onsetSlugs: how });
      return true;
    });
    if (ok) {
      saveLastOnset(how);
      onClose();
    }
  };

  return (
    <Sheet
      title={t('sleep.mode.title')}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-1.5">
          <Btn variant="primary" className="h-12 w-full" onClick={asleep}>
            <Icon name="moon" size={18} className="mr-2 inline-block align-[-3px]" />
            {t('sleep.nowAsleep')}
          </Btn>
          <Btn className="w-full" onClick={prepare}>
            {t('sleep.prepare')}
          </Btn>
        </div>
      }
    >
      <p className="-mt-2 mb-3 text-[13px] font-semibold text-muted">
        {t('sleep.mode.suggested', { type: t(suggested === 'nap' ? 'home.type.nap' : 'home.type.night').toLowerCase(), time: fmtClock(nowMs, ctx.zone) })}
      </p>

      <div role="group" aria-label={t('sleep.mode.title')} className="grid grid-cols-2 gap-2">
        <Toggle icon="sun" on={type === 'nap'} onClick={() => setType('nap')}>
          <span className="block text-[15px] font-extrabold">{t('home.type.nap')}</span>
          <span className="block text-[11px] font-semibold text-muted">{t('sleep.mode.napSub')}</span>
        </Toggle>
        <Toggle icon="moon" on={type === 'night'} onClick={() => setType('night')}>
          <span className="block text-[15px] font-extrabold">{t('home.type.night')}</span>
          <span className="block text-[11px] font-semibold text-muted">{t('sleep.mode.nightSub')}</span>
        </Toggle>
      </div>

      {options.length > 0 && (
        <div className="mt-4" role="group" aria-label={t('sleep.how')}>
          <span className="mb-1.5 block text-[13px] font-bold text-muted">{t('sleep.how')}</span>
          <div className="flex flex-wrap gap-2">
            {options.map((x) => (
              <Chip key={x.id} active={how.includes(x.tag_slug)} onClick={() => toggle(x.tag_slug)}>
                {x.label_i18n['es'] ?? x.tag_slug}
              </Chip>
            ))}
          </div>
          {remembered && <p className="mt-2 text-[12px] font-semibold text-muted">{t('sleep.howRemembered')}</p>}
        </div>
      )}
    </Sheet>
  );
}
