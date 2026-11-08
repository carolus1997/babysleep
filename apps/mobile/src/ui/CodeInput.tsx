import { useId } from 'react';

/**
 * Código numérico en casillas. Debajo hay UN solo `<input>` real y transparente (así funcionan el teclado
 * numérico, pegar y el autorrelleno del SMS/correo); las casillas solo dibujan lo escrito.
 * Con `error`, las casillas y el mensaje pasan a `--danger` (el mensaje lleva texto e icono: no depende del color).
 */
export function CodeInput({
  value,
  onChange,
  label,
  length = 6,
  maxLength = 8,
  error,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  length?: number;
  maxLength?: number;
  error?: string | null;
  onEnter?: () => void;
}) {
  const msgId = useId();
  const boxes = Math.max(length, value.length);
  return (
    <div>
      <div className="relative flex gap-2">
        {Array.from({ length: boxes }, (_, i) => {
          const current = i === value.length;
          return (
            <span
              key={i}
              aria-hidden
              className={`grid h-[60px] min-w-0 flex-1 place-items-center rounded-2xl border-2 bg-surface2 text-2xl font-extrabold tabular-nums ${
                error ? 'border-danger' : current ? 'border-accent' : 'border-transparent'
              }`}
            >
              {value[i] ?? ''}
            </span>
          );
        })}
        <input
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? msgId : undefined}
          className="absolute inset-0 size-full cursor-text opacity-0"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && value.length >= length && onEnter?.()}
        />
      </div>
      {error && (
        <p id={msgId} role="alert" className="mt-2 flex items-center gap-1.5 text-[13px] font-bold text-danger">
          <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          {error}
        </p>
      )}
    </div>
  );
}
