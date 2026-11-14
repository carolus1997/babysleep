import type { TagT } from '@babysleep/contract';
import { useApp } from '../app/AppContext';
import { findObservation, listTags, saveObservation, tagIdsOf, type ObservationTarget } from '../domain/notes';
import { t } from '../i18n/es';
import { useLive } from '../ui/hooks';
import { Icon } from '../ui/Icon';
import { Chip } from '../ui/primitives';

type Mode = 'nap' | 'night';

/**
 * Botón dividido «Dormir» (docs/design/prototypes, vista «Empezar a dormir», opción E): una sola píldora.
 * Tocarla empieza ya con el modo que marca el interruptor sol/luna de la derecha (sugerido por la hora, pero a la
 * vista y cambiable con un toque). Con una preparación abierta, el mismo botón dice «Ya duerme».
 */
export function SleepPill({ mode, onMode, onGo, title, sub, label }: { mode: Mode; onMode: (m: Mode) => void; onGo: () => void; title: string; sub: string; label: string }) {
  return (
    <div data-tour="round" className="flex min-h-[72px] items-center rounded-full bg-accent pl-6 pr-2.5 text-accent-fg shadow-[0_0_0_6px_var(--accent-soft)]">
      <button type="button" onClick={onGo} aria-label={label} className="min-h-[72px] flex-1 text-left transition-transform active:scale-[0.98]">
        <span className="block text-[19px] font-extrabold leading-tight">{title}</span>
        <span className="block text-[12px] font-semibold opacity-90">{sub}</span>
      </button>
      <div role="group" aria-label={t('sleep.pill.mode')} className="flex gap-0.5 rounded-full bg-black/25 p-1">
        {(['nap', 'night'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            aria-label={t(m === 'nap' ? 'home.type.nap' : 'home.type.night')}
            onClick={() => onMode(m)}
            className={`grid size-12 place-items-center rounded-full transition-colors ${mode === m ? 'bg-accent-fg text-accent' : 'text-accent-fg'}`}
          >
            <Icon name={m === 'nap' ? 'sun' : 'moon'} size={22} />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Etiquetas opcionales de una observación (cómo se duerme, o cómo va la preparación). Cada toque guarda al
 * instante, conservando la nota de texto que ya hubiera.
 */
export function TagChips({
  target,
  moment,
  category,
  slugs,
  onChanged,
}: {
  target: ObservationTarget;
  moment: 'onset' | 'settling';
  category: 'onset' | 'settling';
  slugs: readonly string[];
  onChanged?: (slugs: string[]) => void;
}) {
  const { ctx, run } = useApp();
  const tags = useLive(() => listTags(ctx), [ctx], [] as TagT[]);
  const key = JSON.stringify(target);
  const selected = useLive(
    async () => {
      const o = await findObservation(ctx, target, moment);
      return o === undefined ? [] : await tagIdsOf(ctx, o.id);
    },
    [ctx, key, moment],
    [] as string[],
  );
  const options = slugs.map((s) => tags.find((x) => x.tag_slug === s && x.category === category)).filter((x): x is TagT => x !== undefined);
  if (options.length === 0) return null;

  const toggle = (tag: TagT) =>
    run(async () => {
      const next = selected.includes(tag.id) ? selected.filter((x) => x !== tag.id) : [...selected, tag.id];
      const existing = await findObservation(ctx, target, moment);
      await saveObservation(ctx, { target, moment, text: existing?.note_text ?? '', tagIds: next });
      onChanged?.(options.filter((o) => next.includes(o.id)).map((o) => o.tag_slug));
      return true;
    });

  return (
    <div className="flex flex-wrap justify-center gap-2">
      {options.map((x) => (
        <Chip key={x.id} active={selected.includes(x.id)} className={selected.includes(x.id) ? '' : 'bg-surface!'} onClick={() => toggle(x)}>
          {x.label_i18n['es'] ?? x.tag_slug}
        </Chip>
      ))}
    </div>
  );
}
