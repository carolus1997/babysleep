import { useEffect, useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { t } from '../i18n/es';
import { Icon, type IconName } from './Icon';

/*
 * Componentes base del sistema «Marea Crepúsculo» (docs/design/BABYSLEEP_DESIGN_SYSTEM.md §3).
 * Las pantallas no definen colores ni tamaños propios: usan estos componentes y los tokens de index.css.
 */

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<BtnVariant, string> = {
  primary: 'bg-accent text-accent-fg',
  secondary: 'bg-surface2 text-fg hover:bg-surface3',
  ghost: 'bg-transparent text-accent hover:bg-accent-soft',
  danger: 'bg-transparent text-danger border-2 border-danger',
};

export function Btn({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return (
    <button
      {...props}
      className={`min-h-12 rounded-[28px] px-5 font-bold transition-transform active:scale-[0.97] disabled:opacity-45 ${variants[variant]} ${className}`}
    />
  );
}

/** Botón circular dominante de Inicio («Dormir» / «Despierto»): una palabra, icono y halo. */
export function Round({ icon, label, small = false, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; small?: boolean }) {
  return (
    <button
      {...props}
      className={`flex flex-col items-center justify-center whitespace-nowrap rounded-full bg-accent font-extrabold text-accent-fg transition-transform active:scale-[0.95] disabled:opacity-45 ${
        small ? 'size-[72px] shrink-0 gap-px text-[11px] shadow-[0_0_0_5px_var(--accent-soft)]' : 'size-[92px] gap-0.5 text-[13px] shadow-[0_0_0_8px_var(--accent-soft)]'
      } ${className}`}
    >
      <Icon name={icon} size={small ? 22 : 28} />
      {label}
    </button>
  );
}

/** Acción rápida en mosaico: icono arriba y una etiqueta corta. */
export function Tile({ icon, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName }) {
  return (
    <button
      {...props}
      className={`flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-[22px] border border-(--card-border) bg-surface px-1 py-2 text-center text-[12px] font-bold leading-tight shadow-card transition-transform active:scale-[0.97] disabled:opacity-45 ${className}`}
    >
      <Icon name={icon} size={22} className="text-accent" />
      <span>{children}</span>
    </button>
  );
}

/** Chip: elección, filtro o acción corta (−5 min). */
export function Chip({
  active = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...props}
      aria-pressed={active}
      className={`min-h-11 rounded-full px-4 text-sm font-bold transition-colors ${
        active ? 'bg-accent text-accent-fg' : 'bg-surface2 text-fg hover:bg-surface3'
      } ${className}`}
    />
  );
}

/** Sub-navegación de una pantalla: una fila de chips con desplazamiento lateral y degradado en el borde. */
export function Tabs({ label, tour, children }: { label: string; tour?: string; children: ReactNode }) {
  return (
    <div data-tour={tour} role="group" aria-label={label} className="tabs-fade -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
      {children}
    </div>
  );
}

export function Card({ title, children, className = '', ...rest }: { title?: string; children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest} className={`rounded-3xl border border-(--card-border) bg-surface p-4 shadow-card ${className}`}>
      {title && <h2 className="mb-2 text-[13px] font-bold text-muted">{title}</h2>}
      {children}
    </section>
  );
}

/** Bloque anidado dentro de una tarjeta (nunca una `Card` dentro de otra). */
export function Inset({ children, className = '', ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={`rounded-2xl bg-surface2 p-3 ${className}`}>
      {children}
    </div>
  );
}

/** Aviso con icono: `danger` para lo que requiere actuar, `info` para recordatorios. */
export function Banner({
  tone = 'info',
  onClick,
  children,
}: {
  tone?: 'info' | 'danger';
  onClick?: () => void;
  children: ReactNode;
}) {
  const cls = `flex w-full items-center gap-3 rounded-2xl p-3 text-left text-sm font-medium ${
    tone === 'danger' ? 'border-2 border-danger bg-surface text-fg' : 'bg-surface2 text-fg'
  }`;
  const inner = (
    <>
      <Icon name={tone === 'danger' ? 'alert' : 'info'} className={tone === 'danger' ? 'text-danger' : 'text-accent'} />
      <span className="flex-1">{children}</span>
      {onClick && <Icon name="next" size={18} className="text-muted" />}
    </>
  );
  return onClick ? (
    <button className={cls} onClick={onClick} role={tone === 'danger' ? 'alert' : undefined}>
      {inner}
    </button>
  ) : (
    <div className={cls} role={tone === 'danger' ? 'alert' : undefined}>
      {inner}
    </div>
  );
}

/** Estado vacío: dice qué falta y qué hacer, en lugar de ceros o guiones sin contexto. */
export function EmptyState({ icon = 'empty', title, hint, children }: { icon?: IconName; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
        <Icon name={icon} size={28} />
      </span>
      <p className="text-base font-bold">{title}</p>
      {hint && <p className="max-w-xs text-sm text-muted">{hint}</p>}
      {children}
    </div>
  );
}

/** Marcador de carga con la forma del contenido (sin spinners a pantalla completa). */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-2xl bg-surface2 ${className}`} />;
}

/**
 * Anillo de progreso. Solo para indicar una ventana habitual o una duración; nunca un objetivo que cumplir
 * (principio 5 del sistema de diseño).
 */
export function Ring({
  size = 192,
  stroke = 14,
  progress = 0,
  tour,
  neutral = false,
  children,
}: {
  size?: number;
  stroke?: number;
  progress?: number;
  tour?: string;
  /** Trazo neutro: solo el anillo de sueño lleva el acento; el de toma, secundario, no compite con él. */
  neutral?: boolean;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  return (
    <div data-tour={tour} className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface2)" strokeWidth={stroke} />
        {p > 0 && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={neutral ? 'color-mix(in srgb, var(--fg) 55%, transparent)' : 'var(--accent)'} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * p} ${c}`} />
        )}
      </svg>
      <div className={`absolute inset-0 flex flex-col items-center justify-center text-center ${neutral ? 'px-2' : 'px-6'}`}>{children}</div>
    </div>
  );
}

/** Hoja inferior accesible: se cierra con Escape o tocando fuera. */
export function Sheet({ title, onClose, footer, children }: { title: string; onClose: () => void; /** Pie fijo (botón de guardar): se queda visible aunque el contenido se desplace. */ footer?: ReactNode; children: ReactNode }) {
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Mientras hay una hoja abierta, la página de detrás no debe desplazarse (en iOS «baila» con ella).
  useEffect(() => {
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prev;
    };
  }, []);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center overscroll-contain bg-black/60" onClick={onClose}>
      {/* overflow-x-hidden + touch-action: pan-y: con `overflow-y: auto` el eje X pasa a `auto` y cualquier
          píxel de más permite arrastrar la hoja hacia los lados. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className="max-h-[92dvh] w-full max-w-md touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain rounded-t-[28px] border-t border-(--card-border) bg-bg p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-line" />
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id={id} className="text-lg font-extrabold">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-surface2 text-fg transition-transform hover:bg-surface3 active:scale-[0.95]"
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
        {footer && <div className="sticky bottom-[-1rem] -mx-4 mt-3 border-t border-line bg-bg px-4 pb-1 pt-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[13px] font-bold text-muted">{label}</span>
      {children}
    </label>
  );
}

/** `min-w-0 max-w-full`: en Safari de iOS los campos tienen un ancho intrínseco que, en rejillas o flex, desborda la pantalla. */
export const inputCls =
  'block w-full min-w-0 max-w-full min-h-12 rounded-2xl border border-line bg-surface2 px-3.5 text-fg placeholder:text-muted focus:border-accent aria-[invalid=true]:border-danger disabled:opacity-45';
