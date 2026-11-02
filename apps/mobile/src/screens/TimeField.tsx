import { resolveLocal } from '@babysleep/core';
import { t } from '../i18n/es';
import { Field, inputCls } from '../ui/primitives';

export type Choice = 0 | 1 | undefined;

/**
 * Campo de hora local (hora de pared en la zona de referencia). Si la hora no existe o
 * se repite por un cambio de horario, lo dice y obliga a elegir: nunca corrige en silencio.
 */
export function TimeField({
  label,
  value,
  onChange,
  choice,
  onChoice,
  zone,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  choice: Choice;
  onChoice: (c: Choice) => void;
  zone: string;
}) {
  const res = value ? resolveLocal(value, zone) : null;
  return (
    <Field label={label}>
      <input
        type="datetime-local"
        className={inputCls}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          onChoice(undefined);
        }}
      />
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
    </Field>
  );
}

/** ¿El campo está listo para guardarse (existe y, si es ambiguo, se ha elegido)? */
export function timeReady(value: string, zone: string, choice: Choice): boolean {
  if (!value) return false;
  const r = resolveLocal(value, zone);
  return r.status === 'ok' || (r.status === 'ambiguous' && choice !== undefined);
}
