import { useEffect, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { t } from '../i18n/es';

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants: Record<BtnVariant, string> = {
  primary: 'bg-accent text-accent-fg',
  secondary: 'bg-surface2 text-fg border border-line',
  ghost: 'bg-transparent text-accent',
  danger: 'bg-transparent text-danger border border-danger',
};

export function Btn({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return (
    <button
      {...props}
      className={`min-h-12 rounded-2xl px-4 font-semibold active:scale-[0.98] disabled:opacity-50 ${variants[variant]} ${className}`}
    />
  );
}

export function Chip({
  active = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...props}
      aria-pressed={active}
      className={`min-h-11 rounded-full border px-4 text-sm font-medium ${
        active ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface text-fg'
      } ${className}`}
    />
  );
}

export function Card({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-3xl border border-line bg-surface p-4 ${className}`}>
      {title && <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>}
      {children}
    </section>
  );
}

/** Hoja inferior accesible: se cierra con Escape o tocando fuera. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
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
    <div className="fixed inset-0 z-40 flex items-end justify-center overscroll-contain bg-black/50" onClick={onClose}>
      {/* overflow-x-hidden + touch-action: pan-y: con `overflow-y: auto` el eje X pasa a `auto` y cualquier
          píxel de más permite arrastrar la hoja hacia los lados. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className="max-h-[92dvh] w-full max-w-md touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain rounded-t-3xl bg-bg p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id={id} className="text-lg font-bold">
            {title}
          </h2>
          <Btn variant="ghost" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </Btn>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-sm font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

/** `min-w-0 max-w-full`: en Safari de iOS los campos tienen un ancho intrínseco que, en rejillas o flex, desborda la pantalla. */
export const inputCls = 'block w-full min-w-0 max-w-full min-h-12 rounded-2xl border border-line bg-surface px-3 text-fg';
