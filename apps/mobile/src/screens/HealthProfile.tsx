import type { BabyT } from '@babysleep/contract';
import { useState } from 'react';
import { useApp } from '../app/AppContext';
import { HEALTH_TEXT_FIELDS, renameBaby } from '../domain/bootstrap';
import { t, type I18nKey } from '../i18n/es';
import { Btn, Card, Field, inputCls, Sheet } from '../ui/primitives';

type TextKey = keyof typeof HEALTH_TEXT_FIELDS;

const ROWS: ReadonlyArray<{ key: Exclude<TextKey, 'cipa'>; label: I18nKey; tel?: boolean }> = [
  { key: 'pediatrician', label: 'hp.pediatrician' },
  { key: 'nurse', label: 'hp.nurse' },
  { key: 'health_center_name', label: 'hp.centerName' },
  { key: 'health_center_address', label: 'hp.centerAddress' },
  { key: 'health_center_phone', label: 'hp.centerPhone', tel: true },
  { key: 'birth_hospital', label: 'hp.birthHospital' },
  { key: 'allergies', label: 'hp.allergies' },
  { key: 'health_notes', label: 'hp.notes' },
];

/** El CIPA se oculta: solo se ven los 4 últimos caracteres hasta que se pulsa «Mostrar». */
const maskCipa = (c: string): string => (c.length <= 4 ? '••••' : `${'•'.repeat(c.length - 4)}${c.slice(-4)}`);

function EditSheet({ baby, onClose }: { baby: BabyT; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const [v, setV] = useState<Record<TextKey, string>>(() => ({
    pediatrician: baby.pediatrician ?? '',
    nurse: baby.nurse ?? '',
    health_center_name: baby.health_center_name ?? '',
    health_center_address: baby.health_center_address ?? '',
    health_center_phone: baby.health_center_phone ?? '',
    birth_hospital: baby.birth_hospital ?? '',
    allergies: baby.allergies ?? '',
    health_notes: baby.health_notes ?? '',
    cipa: baby.cipa ?? '',
  }));
  const set = (k: TextKey) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    const ok = await run(async () => (await renameBaby(ctx, baby.id, v), true));
    if (ok) {
      toast(t('hp.saved'));
      onClose();
    }
  };
  return (
    <Sheet title={t('hp.edit')} onClose={onClose}>
      {ROWS.filter((r) => r.key !== 'allergies' && r.key !== 'health_notes').map((r) => (
        <Field key={r.key} label={t(r.label)}>
          <input className={inputCls} value={v[r.key]} onChange={set(r.key)} maxLength={HEALTH_TEXT_FIELDS[r.key].max} inputMode={r.tel ? 'tel' : undefined} />
        </Field>
      ))}
      <Field label={t('hp.cipa')}>
        <input className={inputCls} value={v.cipa} onChange={set('cipa')} maxLength={HEALTH_TEXT_FIELDS.cipa.max} autoCapitalize="characters" autoComplete="off" spellCheck={false} />
        <span className="mt-1 block text-xs text-muted">{t('hp.cipaHint')}</span>
      </Field>
      <Field label={t('hp.allergies')}>
        <textarea className={`${inputCls} py-2`} rows={2} value={v.allergies} onChange={set('allergies')} maxLength={HEALTH_TEXT_FIELDS.allergies.max} />
      </Field>
      <Field label={t('hp.notes')}>
        <textarea className={`${inputCls} py-2`} rows={4} value={v.health_notes} onChange={set('health_notes')} maxLength={HEALTH_TEXT_FIELDS.health_notes.max} />
      </Field>
      <div className="flex flex-col gap-2">
        <Btn variant="primary" onClick={save}>
          {t('common.save')}
        </Btn>
        <Btn variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Btn>
      </div>
    </Sheet>
  );
}

/** Ficha de salud del bebé: pediatra, centro de salud, alergias y CIPA (oculto por defecto). */
export function HealthProfile() {
  const { baby, toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [showCipa, setShowCipa] = useState(false);
  if (baby === null) return null;

  // Los perfiles creados antes de la versión 0.5.0 no tienen estos campos guardados (llegan como `undefined`): cuentan como «no consta».
  const cipa = baby.cipa ?? null;
  const empty = ROWS.every((r) => (baby[r.key] ?? null) === null) && cipa === null;
  const copyCipa = async () => {
    try {
      await navigator.clipboard.writeText(cipa ?? '');
      toast(t('hp.copied'));
    } catch {
      toast(t('common.error', { msg: 'copiar' }));
    }
  };

  return (
    <div className="space-y-4">
      <Card title={t('hp.title')}>
        {empty ? (
          <p className="text-sm text-muted">{t('hp.empty')}</p>
        ) : (
          <dl className="space-y-2 text-sm">
            {ROWS.map((r) => {
              const val = baby[r.key] ?? null;
              if (val === null) return null;
              return (
                <div key={r.key}>
                  <dt className="text-xs text-muted">{t(r.label)}</dt>
                  <dd className="whitespace-pre-wrap font-medium">
                    {r.tel ? (
                      <a className="text-accent underline" href={`tel:${val.replace(/[^\d+]/g, '')}`}>
                        {val}
                      </a>
                    ) : (
                      val
                    )}
                  </dd>
                </div>
              );
            })}
            {cipa !== null && (
              <div>
                <dt className="text-xs text-muted">{t('hp.cipa')}</dt>
                <dd className="flex flex-wrap items-center gap-2 font-mono font-medium">
                  <span aria-live="polite">{showCipa ? cipa : maskCipa(cipa)}</span>
                  <Btn variant="ghost" className="min-h-10 px-2 font-sans text-sm" onClick={() => setShowCipa((x) => !x)}>
                    {showCipa ? t('hp.hide') : t('hp.show')}
                  </Btn>
                  <Btn variant="ghost" className="min-h-10 px-2 font-sans text-sm" onClick={copyCipa}>
                    {t('hp.copy')}
                  </Btn>
                </dd>
              </div>
            )}
          </dl>
        )}
        <Btn className="mt-3 w-full" onClick={() => setEditing(true)}>
          {empty ? t('hp.fill') : t('hp.edit')}
        </Btn>
      </Card>
      <p className="text-xs text-muted">{t('hp.privacy')}</p>
      {editing && <EditSheet baby={baby} onClose={() => setEditing(false)} />}
    </div>
  );
}
