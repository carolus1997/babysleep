import type { BabyT, EventCategoryT, LifeEventT } from '@babysleep/contract';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../app/AppContext';
import { createBaby, renameBaby } from '../domain/bootstrap';
import { buildBackupJson, buildSessionsCsv } from '../domain/export';
import { applyImport, planImport, type ImportPlan } from '../domain/import';
import { addLifeEvent, deleteLifeEvent, listLifeEvents } from '../domain/notes';
import { removeBabyPhoto, setBabyPhoto } from '../domain/photo';
import { t } from '../i18n/es';
import { download, fmtAge } from '../ui/format';
import { getThemePref, setThemePref, useLive, type ThemePref } from '../ui/hooks';
import { resizeImage } from '../ui/image';
import { Avatar, useBabyPhotoUrl, useBlobUrl } from '../ui/photo';
import { Btn, Card, Chip, Field, inputCls, Sheet } from '../ui/primitives';

const THEMES: ThemePref[] = ['auto', 'light', 'dark', 'night'];

/** Texto de un campo numérico → número, `null` si está vacío, NaN si no se entiende (lo rechaza el dominio). */
const toNum = (s: string): number | null => (s.trim() === '' ? null : Number(s.trim().replace(',', '.')));

function BabySheet({ baby, onClose }: { baby: BabyT | null; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const [alias, setAlias] = useState(baby?.alias ?? '');
  const [birth, setBirth] = useState(baby?.birth_date ?? '');
  const [sex, setSex] = useState<'female' | 'male' | null>(baby?.sex ?? null);
  const [gest, setGest] = useState(baby?.gestational_weeks?.toString() ?? '');
  const [weight, setWeight] = useState(baby?.birth_weight_g?.toString() ?? '');
  const [length, setLength] = useState(baby?.birth_length_cm?.toString() ?? '');
  const [notes, setNotes] = useState(baby?.notes ?? '');
  // undefined = sin cambios · Blob = foto nueva (aún sin guardar) · null = quitar la foto
  const [photo, setPhoto] = useState<Blob | null | undefined>(undefined);
  const saved = useBabyPhotoUrl(baby?.id ?? '');
  const pending = useBlobUrl(photo instanceof Blob ? photo : null);
  const shown = photo === undefined ? saved : pending;
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      setPhoto(await resizeImage(file));
    } catch {
      toast(t('baby.photo.error'));
    }
  };

  return (
    <Sheet title={baby ? t('common.edit') : t('settings.addBaby')} onClose={onClose}>
      <div className="mb-4 flex items-center gap-4">
        {shown ? (
          <img src={shown} alt="" className="size-24 shrink-0 rounded-full object-cover" />
        ) : (
          <span aria-hidden className="inline-flex size-24 shrink-0 items-center justify-center rounded-full bg-surface2 text-3xl text-muted">
            {alias.trim().slice(0, 1).toUpperCase() || '☺'}
          </span>
        )}
        <div className="flex flex-col gap-2">
          <Btn onClick={() => galleryRef.current?.click()}>{t('baby.photo.gallery')}</Btn>
          <Btn onClick={() => cameraRef.current?.click()}>{t('baby.photo.camera')}</Btn>
          {shown && (
            <Btn variant="ghost" onClick={() => setPhoto(null)}>
              {t('baby.photo.remove')}
            </Btn>
          )}
        </div>
        <input
          ref={galleryRef}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label={t('baby.photo.gallery')}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            void pick(f);
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          aria-label={t('baby.photo.camera')}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            void pick(f);
          }}
        />
      </div>
      <p className="mb-4 text-xs text-muted">{t('baby.photo.hint')}</p>

      <Field label={t('baby.alias')}>
        <input className={inputCls} value={alias} onChange={(e) => setAlias(e.target.value)} />
      </Field>
      <Field label={t('baby.birth')}>
        <input className={inputCls} type="date" value={birth} onChange={(e) => setBirth(e.target.value)} />
      </Field>

      <p className="mb-2 mt-1 text-sm font-semibold uppercase tracking-wide text-muted">{t('baby.more')}</p>
      <div className="mb-3" role="group" aria-label={t('baby.sex')}>
        <span className="mb-1 block text-sm font-medium text-muted">{t('baby.sex')}</span>
        <div className="flex flex-wrap gap-2">
          <Chip active={sex === 'female'} onClick={() => setSex('female')}>
            {t('baby.sex.female')}
          </Chip>
          <Chip active={sex === 'male'} onClick={() => setSex('male')}>
            {t('baby.sex.male')}
          </Chip>
          <Chip active={sex === null} onClick={() => setSex(null)}>
            {t('baby.sex.none')}
          </Chip>
        </div>
      </div>
      <Field label={t('baby.gestation')}>
        <input className={inputCls} inputMode="numeric" value={gest} onChange={(e) => setGest(e.target.value)} placeholder="40" />
        <span className="mt-1 block text-xs text-muted">{t('baby.gestationHint')}</span>
      </Field>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
        <Field label={t('baby.weight')}>
          <input className={inputCls} inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </Field>
        <Field label={t('baby.length')}>
          <input className={inputCls} inputMode="decimal" value={length} onChange={(e) => setLength(e.target.value)} />
        </Field>
      </div>
      <Field label={t('baby.notes')}>
        <textarea className={`${inputCls} py-2`} rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <Btn
        variant="primary"
        className="w-full"
        disabled={alias.trim() === '' || birth === ''}
        onClick={async () => {
          const profile = {
            sex,
            gestational_weeks: toNum(gest),
            birth_weight_g: toNum(weight),
            birth_length_cm: toNum(length),
            notes,
          };
          const result = await run(async () => {
            const b = baby
              ? await renameBaby(ctx, baby.id, { alias, birth_date: birth, ...profile })
              : await createBaby(ctx, { alias, birthDate: birth, ...profile });
            if (photo instanceof Blob) await setBabyPhoto(ctx, b.id, photo);
            else if (photo === null) await removeBabyPhoto(ctx, b.id);
            return b;
          });
          if (result) onClose();
        }}
      >
        {t('common.save')}
      </Btn>
    </Sheet>
  );
}

function ImportSheet({ plan, onClose }: { plan: ImportPlan; onClose: () => void }) {
  const { ctx, run, toast } = useApp();
  const [overwrite, setOverwrite] = useState(false);
  const total = Object.values(plan.toAdd).flat().length;
  const nothingToDo = total === 0 && !(overwrite && plan.newerInBackup.length > 0);
  return (
    <Sheet title={t('import.title')} onClose={onClose}>
      {!plan.ok ? (
        <>
          <p role="alert" className="mb-2 font-semibold text-danger">
            {t('import.invalid')}
          </p>
          <ul className="mb-3 list-disc space-y-1 pl-5 text-sm">
            {plan.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <Btn className="w-full" onClick={onClose}>
            {t('common.close')}
          </Btn>
        </>
      ) : (
        <>
          {plan.exportedAt && (
            <p className="mb-2 text-sm text-muted">{t('import.fromDate', { when: new Date(plan.exportedAt).toLocaleString('es-ES', { timeZone: ctx.zone }) })}</p>
          )}
          <ul className="mb-3 space-y-1 text-sm">
            <li className="font-semibold">{total > 0 ? t('import.willAdd', { n: total, s: plan.counts.sessions }) : t('import.nothing')}</li>
            {plan.counts.babies.length > 0 && <li>{t('import.babies', { names: plan.counts.babies.join(', ') })}</li>}
            {plan.unchanged > 0 && <li className="text-muted">{t('import.unchanged', { n: plan.unchanged })}</li>}
            {plan.mergedDuplicates > 0 && <li className="text-muted">{t('import.merged', { n: plan.mergedDuplicates })}</li>}
            {plan.newerLocal > 0 && <li className="text-muted">{t('import.newerLocal', { n: plan.newerLocal })}</li>}
            {plan.sameRevDiffers.length > 0 && <li className="text-muted">{t('import.sameRev', { n: plan.sameRevDiffers.length })}</li>}
          </ul>
          {plan.newerInBackup.length > 0 && (
            <div className="mb-3 rounded-2xl border border-line bg-surface p-3 text-sm">
              <p className="mb-2">{t('import.newerBackup', { n: plan.newerInBackup.length })}</p>
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
                {t('import.overwrite', { n: plan.newerInBackup.length })}
              </label>
              <p className="mt-1 text-xs text-muted">{t('import.keepLocal')}</p>
            </div>
          )}
          <Btn
            variant="primary"
            className="w-full"
            disabled={nothingToDo}
            onClick={async () => {
              const r = await run(() => applyImport(ctx, plan, { overwriteNewer: overwrite }));
              if (r) {
                toast(t('import.done', { n: r.added + r.overwritten }));
                onClose();
              }
            }}
          >
            {t('import.apply')}
          </Btn>
        </>
      )}
    </Sheet>
  );
}

function EventSheet({ onClose }: { onClose: () => void }) {
  const { ctx, baby, run } = useApp();
  const cats = useLive(() => ctx.db.event_category.toArray(), [ctx], [] as EventCategoryT[]);
  const [cat, setCat] = useState('');
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState('');
  const [desc, setDesc] = useState('');
  const [all, setAll] = useState(false);
  const categoryId = cat || cats[0]?.id || '';
  return (
    <Sheet title={t('settings.addEvent')} onClose={onClose}>
      <Field label={t('event.category')}>
        <select className={inputCls} value={categoryId} onChange={(e) => setCat(e.target.value)}>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label_i18n['es']}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('event.start')}>
        <input className={inputCls} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </Field>
      <Field label={t('event.end')}>
        <input className={inputCls} type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
      </Field>
      <Field label={t('event.description')}>
        <input className={inputCls} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      <label className="mb-4 flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        {t('event.allFamily')}
      </label>
      <Btn
        variant="primary"
        className="w-full"
        disabled={!categoryId || !start}
        onClick={async () => {
          const ok = await run(() =>
            addLifeEvent(ctx, { babyId: all ? null : (baby?.id ?? null), categoryId, startDate: start, endDate: end || null, description: desc }),
          );
          if (ok) onClose();
        }}
      >
        {t('event.save')}
      </Btn>
    </Sheet>
  );
}

export function Settings() {
  const { ctx, babies, baby, run } = useApp();
  const [babySheet, setBabySheet] = useState<BabyT | null | 'new'>(null);
  const [eventSheet, setEventSheet] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const events = useLive(() => (baby ? listLifeEvents(ctx, baby.id) : Promise.resolve([])), [ctx, baby?.id], [] as LifeEventT[]);
  const cats = useLive(() => ctx.db.event_category.toArray(), [ctx], [] as EventCategoryT[]);
  const lastExport = useLive(async () => (await ctx.db.meta.get('last_export_at'))?.value as string | undefined, [ctx], undefined as string | undefined);

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(false));
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('settings.title')}</h1>

      <Card title={t('settings.babies')}>
        <ul className="divide-y divide-line">
          {babies.map((b) => (
            <li key={b.id} className="flex min-h-14 items-center justify-between">
              <span className="flex items-center gap-3">
                <Avatar baby={b} size={36} />
                <span>
                  <span className="font-medium">{b.alias}</span>
                  <span className="ml-2 text-sm text-muted">{fmtAge(b.birth_date, Date.now())}</span>
                </span>
              </span>
              <Btn variant="ghost" onClick={() => setBabySheet(b)}>
                {t('common.edit')}
              </Btn>
            </li>
          ))}
        </ul>
        <Btn className="mt-2 w-full" onClick={() => setBabySheet('new')}>
          + {t('settings.addBaby')}
        </Btn>
      </Card>

      <Card title={t('settings.diary')}>
        <ul className="divide-y divide-line">
          {events.map((e) => (
            <li key={e.id} className="flex min-h-12 items-center justify-between text-sm">
              <span>
                <strong>{cats.find((c) => c.id === e.category_id)?.label_i18n['es']}</strong> · {e.start_date}
                {e.end_date ? ` → ${e.end_date}` : ''}
                {e.description ? ` · ${e.description}` : ''}
              </span>
              <Btn variant="ghost" aria-label={t('common.delete')} onClick={() => run(() => deleteLifeEvent(ctx, e.id))}>
                ✕
              </Btn>
            </li>
          ))}
        </ul>
        <Btn className="mt-2 w-full" onClick={() => setEventSheet(true)}>
          + {t('settings.addEvent')}
        </Btn>
      </Card>

      <Card title={t('settings.data')}>
        <div className="flex flex-col gap-2">
          <Btn variant="primary" onClick={async () => download(await buildBackupJson(ctx))}>
            {t('settings.exportJson')}
          </Btn>
          <Btn onClick={async () => download(await buildSessionsCsv(ctx))}>{t('settings.exportCsv')}</Btn>
          <Btn onClick={() => fileRef.current?.click()}>{t('settings.import')}</Btn>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label={t('settings.import')}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = ''; // permite elegir el mismo archivo otra vez
              if (file) setPlan(await planImport(ctx, await file.text()));
            }}
          />
        </div>
        <p className="mt-2 text-sm text-muted">
          {lastExport ? t('settings.lastExport', { when: new Date(lastExport).toLocaleString('es-ES', { timeZone: ctx.zone }) }) : t('settings.neverExported')}
        </p>
        <p className="mt-1 text-sm text-muted">
          {t('settings.storage')}: {persisted ? t('settings.storageYes') : t('settings.storageNo')}
        </p>
      </Card>

      <Card title={t('settings.appearance')}>
        <div className="flex flex-wrap gap-2">
          {THEMES.map((p) => (
            <Chip
              key={p}
              active={theme === p}
              onClick={() => {
                setTheme(p);
                setThemePref(p);
              }}
            >
              {t(`settings.theme.${p}` as 'settings.theme.auto')}
            </Chip>
          ))}
        </div>
      </Card>

      <Card title={t('settings.about')}>
        <p className="text-sm text-muted">{t('settings.privacy')}</p>
        <p className="mt-2 text-sm text-muted">{t('settings.install')}</p>
        <p className="mt-2 text-xs text-muted">BabySleep 0.1 · {ctx.zone}</p>
      </Card>

      {babySheet !== null && <BabySheet baby={babySheet === 'new' ? null : babySheet} onClose={() => setBabySheet(null)} />}
      {eventSheet && <EventSheet onClose={() => setEventSheet(false)} />}
      {plan && <ImportSheet plan={plan} onClose={() => setPlan(null)} />}
    </div>
  );
}
