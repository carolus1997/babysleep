import { useId, useState, type ReactNode } from 'react';
import { t } from '../i18n/es';
import { Icon } from './Icon';

/**
 * Qué desplegables de una lista están abiertos. Hasta que se toca alguno, valen los abiertos «por defecto» (que
 * pueden cambiar mientras llegan los datos); después manda lo que ha abierto o cerrado la persona. Vive mientras la
 * pantalla está montada: no se guarda.
 */
export function useOpenSet(defaultIds: readonly string[] = []) {
  const [touched, setTouched] = useState<ReadonlySet<string> | null>(null);
  const has = (id: string) => (touched === null ? defaultIds.includes(id) : touched.has(id));
  return {
    isOpen: has,
    toggle: (id: string) =>
      setTouched((prev) => {
        const next = new Set(prev ?? defaultIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    openAll: (ids: readonly string[]) => setTouched(new Set(ids)),
    closeAll: () => setTouched(new Set()),
    /** ¿Hay alguno abierto de estos? (decide si el botón dice «Expandir todo» o «Contraer todo»). */
    anyOpen: (ids: readonly string[]) => ids.some(has),
  };
}

/** Barra de composición de un día (siestas y noche) bajo el resumen. */
export function ShareBar({ nap, night }: { nap: number; night: number }) {
  const total = nap + night;
  if (total <= 0) return null;
  return (
    <span aria-hidden className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-surface2">
      <i className="bg-nap" style={{ width: `${(nap / total) * 100}%` }} />
      <i className="bg-night" style={{ width: `${(night / total) * 100}%` }} />
    </span>
  );
}

/**
 * Fila desplegable: toda la fila es el botón (título, resumen y chevrón), con `aria-expanded`. El resumen deja ver lo
 * importante sin abrir (el total del día, el estado de la vacuna). Ver docs/design/prototypes (vista «Navegación y
 * desplegables») y BABYSLEEP_DESIGN_SYSTEM.md.
 */
export function Disclosure({
  title,
  summary,
  badge,
  bar,
  open,
  onToggle,
  children,
  className = '',
}: {
  title: ReactNode;
  summary?: ReactNode;
  /** Estado a la derecha (p. ej. «Sin confirmar»). */
  badge?: ReactNode;
  /** Algo bajo el resumen (p. ej. la barra de siestas y noche). */
  bar?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={`overflow-hidden rounded-3xl border border-(--card-border) bg-surface shadow-card ${className}`}>
      <h3 className="m-0">
        <button
          type="button"
          id={`${id}-b`}
          aria-expanded={open}
          aria-controls={`${id}-p`}
          onClick={onToggle}
          className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-surface2"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[14.5px] font-extrabold">{title}</span>
            {summary && <span className="block text-[12px] font-semibold text-muted">{summary}</span>}
            {bar}
          </span>
          {badge && <span className="shrink-0 text-[12px] font-bold">{badge}</span>}
          <Icon name="down" size={20} className={`text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </h3>
      {open && (
        <div id={`${id}-p`} role="region" aria-labelledby={`${id}-b`} className="border-t border-line px-4 pb-3 pt-1">
          {children}
        </div>
      )}
    </section>
  );
}

/** «Por días · Expandir todo»: abre o cierra de golpe todos los desplegables de una lista. */
export function ExpandBar({ label, anyOpen, onExpand, onCollapse }: { label: string; anyOpen: boolean; onExpand: () => void; onCollapse: () => void }) {
  return (
    <div className="-mb-1 flex items-center justify-between">
      <span className="text-[13px] font-bold text-muted">{label}</span>
      <button type="button" onClick={anyOpen ? onCollapse : onExpand} className="min-h-11 px-1 text-[13px] font-extrabold text-accent">
        {anyOpen ? t('disc.collapseAll') : t('disc.expandAll')}
      </button>
    </div>
  );
}
