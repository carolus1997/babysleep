import { useId } from 'react';

/**
 * Símbolo de BabySleep: el anillo de sueño de «Hoy» (arco de acento) con la luna dentro. Es la misma geometría que el
 * icono de la app (public/icon.svg), pero con los colores del tema para que valga en claro, oscuro y noche.
 * Sin fondo: va sobre la superficie de la pantalla. Decorativo salvo que se le dé `label`.
 */
export function Logo({ size = 72, label, className = '' }: { size?: number; label?: string; className?: string }) {
  const id = useId();
  const a11y = label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const);
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={`shrink-0 ${className}`} {...a11y}>
      <defs>
        <mask id={id}>
          <rect width="100" height="100" fill="#fff" />
          <circle cx="58" cy="43" r="13" fill="#000" />
        </mask>
      </defs>
      <circle cx="50" cy="50" r="31" fill="none" stroke="var(--surface2)" strokeWidth="9" />
      <circle cx="50" cy="50" r="31" fill="none" stroke="var(--accent)" strokeWidth="9" strokeLinecap="round" strokeDasharray="140.25 999" transform="rotate(-90 50 50)" />
      <circle cx="50" cy="50" r="16" fill="var(--seg-nap)" mask={`url(#${id})`} />
    </svg>
  );
}
