import type { BabyT, EventCategoryT, LifeEventT } from '@babysleep/contract';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../app/AppContext';
import { createBaby, renameBaby } from '../domain/bootstrap';
import { buildBackupJson, buildSessionsCsv } from '../domain/export';
import { applyImport, planImport, type ImportPlan } from '../domain/import';
import { addLifeEvent, deleteLifeEvent, listLifeEvents } from '../domain/notes';
import { t } from '../i18n/es';
import { download, fmtAge } from '../ui/format';
import { getThemePref, setThemePref, useLive, type ThemePref } from '../ui/hooks';
import { Btn, Card, Chip, Field, inputCls, Sheet } from '../ui/primitives';

const THEMES: ThemePref[] = ['auto', 'light', 'dark', 'night'];

function BabySheet({ baby, onClose }: { baby: BabyT | null; onClose: () => void }) {
  const { ctx, run } = useApp();
  const [alias, setAlias] = useState(baby?.alias ?? '');
  const [birth, setBirth] = useState(baby?.birth_date ?? '');
  return (
    <Sheet title={baby ? t('common.edit') : t('settings.addBaby')} onClose={onClose}>
      <Field label={t('baby.alias')}>
        <input className={inputCls} value={alias} onChange={(e) => setAlias(e.target.value)} />
      </Field>
      <Field label={t('baby.birth')}>
        <input className={inputCls} type="date" value={birth} onChange={(e) => setBirth(e.target.value)} />
      </Field>
      <Btn
        variant="primary"
        className="w-full"
        disabled={alias.trim() === '' || birth === ''}
        onClick={async () => {
          const ok = await run(() => (baby ? renameBaby(ctx, baby.id, { alias: alias.trim(), birth_date: birth }) : createBaby(ctx, { alias, birthDate: birth })));
          if (ok) onClose();
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
              <span>
                <span className="mr-2 inline-block size-3 rounded-full" style={{ background: b.color ?? 'var(--accent)' }} />
                <span className="font-medium">{b.alias}</span>
                <span className="ml-2 text-sm text-muted">{fmtAge(b.birth_date, Date.now())}</span>
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
