import type { AwakeningT, FeedingT, SleepSessionT } from '@babysleep/contract';
import { useMemo } from 'react';
import { useApp } from '../app/AppContext';
import { listAwakenings, thresholdMs } from '../domain/awakening';
import { listFeedings } from '../domain/feeding';
import { listSessions } from '../domain/sleep';
import { t } from '../i18n/es';
import { download } from '../ui/format';
import { useLive, useNow } from '../ui/hooks';
import { Btn, Card } from '../ui/primitives';
import { buildReport, reportToHtml, reportToText, type Report as ReportData } from '../ui/report';

/** Módulo de análisis 5: resumen semanal para compartir con el pediatra. */
export function Report() {
  const { ctx, baby } = useApp();
  const babyId = baby?.id ?? '';
  const sessions = useLive(() => listSessions(ctx, babyId), [ctx, babyId], [] as SleepSessionT[]);
  const feedings = useLive(() => listFeedings(ctx, babyId), [ctx, babyId], [] as FeedingT[]);
  const awakenings = useLive(() => listAwakenings(ctx, babyId), [ctx, babyId], [] as AwakeningT[]);
  const now = useNow(300_000);
  const thr = thresholdMs(baby ?? undefined);
  const rep = useMemo(
    () => (baby === null ? null : buildReport({ baby, sessions, feedings, awakenings, awakeningThresholdMs: thr, zone: ctx.zone, nowMs: now })),
    [baby, sessions, feedings, awakenings, thr, ctx.zone, now],
  );
  if (baby === null || rep === null) return null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('report.intro')}</p>
      <ReportView rep={rep} filenameBase="informe-semanal" nowMs={now} />
    </div>
  );
}

/** Un informe ya construido, con sus tres salidas: compartir, copiar el texto y guardar como HTML (sirve a cualquier informe). */
export function ReportView({ rep, filenameBase, nowMs }: { rep: ReportData; filenameBase: string; nowMs: number }) {
  const { toast } = useApp();
  const text = reportToText(rep);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('report.copied'));
    } catch {
      toast(t('common.error', { msg: 'copiar' }));
    }
  };
  const share = async () => {
    if (typeof navigator.share !== 'function') return copy();
    try {
      await navigator.share({ title: rep.title, text });
    } catch {
      /* el usuario cerró la hoja de compartir: no es un error */
    }
  };
  const save = () => {
    download({ filename: `${filenameBase}-${new Date(nowMs).toISOString().slice(0, 10)}.html`, mime: 'text/html', content: reportToHtml(rep) });
    toast(t('report.downloaded'));
  };

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-lg font-bold">{rep.title}</h2>
        <p className="mb-3 text-sm text-muted">{rep.subtitle}</p>
        {rep.sections.map((s) => (
          <div key={s.title} className="mb-3">
            <h3 className="mb-1 text-[13px] font-bold text-muted">{s.title}</h3>
            <ul className="space-y-1 text-sm">
              {s.lines.map((l, i) => (
                <li key={`${i}-${l}`}>{l}</li>
              ))}
            </ul>
          </div>
        ))}
        <p className="text-xs text-muted">{rep.footer}</p>
      </Card>
      <div className="flex flex-col gap-2">
        <Btn variant="primary" onClick={share}>
          {t('report.share')}
        </Btn>
        <Btn onClick={copy}>{t('report.copy')}</Btn>
        <Btn onClick={save}>{t('report.download')}</Btn>
      </div>
    </div>
  );
}
