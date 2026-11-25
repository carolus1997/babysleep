import { resolveLocal } from '@babysleep/core';
import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n/es';
import { inputCls } from '../ui/primitives';
import { addedText, dateAfter, isCompleteLocal, joinLocal, padPart, splitLocal, typeDigits, wholeTime, type TimeParts } from '../ui/timeInput';

export type Choice = 0 | 1 | undefined;

const boxCls = `${inputCls} px-1! text-center text-lg font-extrabold tabular-nums`;

/**
 * Campo de hora local (hora de pared en la zona de referencia): la fecha aparte y la hora ESCRITA en dos casillas
 * «00 : 00», sin el reloj del móvil; al completar las horas se pasa solo a los minutos. Si la hora no existe o se
 * repite por un cambio de horario, lo dice y obliga a elegir: nunca corrige en silencio.
 */
export function TimeField({
  label,
  value,
  onChange,
  choice,
  onChoice,
  zone,
  after,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  choice: Choice;
  onChoice: (c: Choice) => void;
  zone: string;
  /** Inicio del que este campo es el fin: sirve para proponer la fecha cuando el campo está vacío. */
  after?: string;
}) {
  const id = useId();
  const base = after !== undefined && isCompleteLocal(after) ? after : undefined;
  const [parts, setParts] = useState<TimeParts>(() => splitLocal(value));
  // Si la fecha la ha puesto la persona (o venía en el valor), no se vuelve a proponer.
  const ownDate = useRef(value !== '');
  const emitted = useRef(value);
  // Recién entrada una casilla, la primera cifra sustituye lo que hubiera, esté o no seleccionado.
  const fresh = useRef(false);
  const hhRef = useRef<HTMLInputElement>(null);
  const mmRef = useRef<HTMLInputElement>(null);

  // Un cambio que viene de fuera (no de teclear aquí) se refleja en las casillas.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    ownDate.current = value !== '';
    setParts(splitLocal(value));
  }, [value]);

  const shownDate = parts.date !== '' || ownDate.current ? parts.date : (base?.slice(0, 10) ?? '');

  const update = (next: TimeParts) => {
    let p = next;
    if (!ownDate.current && base !== undefined) {
      const whole = next.hh.length === 2 && next.mm.length === 2;
      p = { ...next, date: whole ? dateAfter(base, next.hh, next.mm) : base.slice(0, 10) };
    }
    setParts(p);
    const out = joinLocal(p);
    emitted.current = out;
    onChange(out);
    onChoice(undefined);
  };

  const typed = (part: 'hh' | 'mm', raw: string) => {
    const pasted = part === 'hh' ? wholeTime(raw) : null;
    if (pasted) {
      update({ ...parts, ...pasted });
      mmRef.current?.focus();
      return;
    }
    const r = typeDigits(fresh.current ? addedText(parts[part], raw) : raw, part);
    fresh.current = false;
    update({ ...parts, [part]: r.value });
    if (r.done && part === 'hh') mmRef.current?.focus();
  };

  const box = (part: 'hh' | 'mm') => (
    <input
      ref={part === 'hh' ? hhRef : mmRef}
      className={boxCls}
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      placeholder="00"
      aria-label={`${label}: ${t(part === 'hh' ? 'time.hours' : 'time.minutes')}`}
      value={parts[part]}
      onFocus={(e) => {
        fresh.current = true;
        e.currentTarget.select();
      }}
      // Sin esto, al soltar el dedo se deshace la selección.
      onMouseUp={(e) => e.preventDefault()}
      onChange={(e) => typed(part, e.target.value)}
      onBlur={(e) => {
        // Al saltar solo a la siguiente casilla, `parts` aún no tiene lo recién tecleado: entonces no se toca.
        const shown = e.currentTarget.value;
        if (shown.length === 1 && shown === parts[part]) update({ ...parts, [part]: padPart(shown) });
      }}
      onKeyDown={(e) => {
        if (part === 'mm' && e.key === 'Backspace' && parts.mm === '') {
          e.preventDefault();
          hhRef.current?.focus();
        }
      }}
    />
  );

  const res = isCompleteLocal(value) ? resolveLocal(value, zone) : null;
  const incomplete = value !== '' && !isCompleteLocal(value);
  return (
    <div className="mb-3" role="group" aria-labelledby={id}>
      <span id={id} className="mb-1 block text-[13px] font-bold text-muted">
        {label}
      </span>
      <div className="grid grid-cols-[minmax(0,1fr)_3.5rem_auto_3.5rem] items-center gap-1.5">
        <input
          type="date"
          className={inputCls}
          aria-label={`${label}: ${t('time.date')}`}
          value={shownDate}
          onChange={(e) => {
            ownDate.current = true;
            update({ ...parts, date: e.target.value });
          }}
        />
        {box('hh')}
        <span aria-hidden className="text-lg font-extrabold">
          :
        </span>
        {box('mm')}
      </div>
      {incomplete && <p className="mt-1 text-sm text-muted">{t('time.incomplete')}</p>}
      {res?.status === 'nonexistent' && (
        <p role="alert" className="mt-1 text-sm text-danger">
          {t('session.nonexistent')}
        </p>
      )}
      {res?.status === 'ambiguous' && (
        <fieldset className="mt-2 rounded-2xl border border-line p-3">
          <legend className="px-1 text-sm text-muted">{t('session.ambiguous')}</legend>
          {([0, 1] as const).map((c) => (
            <label key={c} className="flex min-h-11 items-center gap-2">
              <input type="radio" checked={choice === c} onChange={() => onChoice(c)} />
              {t(c === 0 ? 'session.ambiguous.first' : 'session.ambiguous.second')}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/** ¿El campo está listo para guardarse (completo, existe y, si es ambiguo, se ha elegido)? */
export function timeReady(value: string, zone: string, choice: Choice): boolean {
  if (!isCompleteLocal(value)) return false;
  const r = resolveLocal(value, zone);
  return r.status === 'ok' || (r.status === 'ambiguous' && choice !== undefined);
}
