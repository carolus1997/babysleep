import { mean, median, quantile, sampleSd, sum } from './stats/descriptive';

/** Un periodo agregado histórico («Día 1»…): duraciones sin marcas temporales. */
export interface AggregatePeriodInput {
  label: string;
  items: ReadonlyArray<{ kind: 'nap' | 'night'; duration_s: number }>;
}

export interface AggregateSummary {
  periods: number;
  nightTotalS: number;
  napTotalS: number;
  nightMeanS: number | null;
  napMeanS: number | null;
  totalMeanS: number | null;
  napCountTotal: number;
  napCountMean: number | null;
  nightMedianS: number | null;
  napDailyMedianS: number | null;
  nightQ1S: number | null;
  nightQ3S: number | null;
  nightSdS: number | null;
}

/**
 * Resumen de periodos agregados. Solo suma lo registrado: no infiere horarios ni
 * ventanas de vigilia, y no reinterpreta las duraciones nocturnas como sueño efectivo.
 */
export function summarizeAggregate(periods: readonly AggregatePeriodInput[]): AggregateSummary {
  const night = periods.map((p) => sum(p.items.filter((i) => i.kind === 'night').map((i) => i.duration_s)));
  const nap = periods.map((p) => sum(p.items.filter((i) => i.kind === 'nap').map((i) => i.duration_s)));
  const napCounts = periods.map((p) => p.items.filter((i) => i.kind === 'nap').length);
  const totals = periods.map((_, i) => (night[i] as number) + (nap[i] as number));
  return {
    periods: periods.length,
    nightTotalS: sum(night),
    napTotalS: sum(nap),
    nightMeanS: mean(night),
    napMeanS: mean(nap),
    totalMeanS: mean(totals),
    napCountTotal: sum(napCounts),
    napCountMean: mean(napCounts),
    nightMedianS: median(night),
    napDailyMedianS: median(nap),
    nightQ1S: quantile(night, 0.25),
    nightQ3S: quantile(night, 0.75),
    nightSdS: sampleSd(night),
  };
}
