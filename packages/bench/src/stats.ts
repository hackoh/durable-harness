/** Summary statistics for one metric across samples. */
export interface Summary {
  n: number;
  p50: number;
  p90: number;
  min: number;
  max: number;
  mean: number;
  /** Samples that reported this metric but could not measure it (left out of the quantiles). */
  missing?: number;
}

/** Linear-interpolated quantile (same definition as numpy's default). */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function summarize(values: number[]): Summary | undefined {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return undefined;
  const r = (v: number) => Math.round(v);
  return {
    n: xs.length,
    p50: r(quantile(xs, 0.5)),
    p90: r(quantile(xs, 0.9)),
    min: r(xs[0]!),
    max: r(xs.at(-1)!),
    mean: r(xs.reduce((a, b) => a + b, 0) / xs.length),
  };
}

/** Summaries for every metric that appears in `samples`. */
export function summarizeSamples(
  samples: { metrics: Record<string, number | undefined>; estimated?: string[] }[]
): Record<string, Summary> {
  const byMetric = new Map<string, number[]>();
  const missing = new Map<string, number>();
  for (const s of samples) {
    for (const [k, v] of Object.entries(s.metrics)) {
      let list = byMetric.get(k);
      if (!list) byMetric.set(k, (list = []));
      // An estimated figure is reported per sample but kept out of the
      // summary: it is a bound, not a measurement.
      if (v === undefined || !Number.isFinite(v) || s.estimated?.includes(k)) {
        missing.set(k, (missing.get(k) ?? 0) + 1);
        continue;
      }
      list.push(v);
    }
  }
  const out: Record<string, Summary> = {};
  for (const [k, v] of byMetric) {
    const s = summarize(v);
    const m = missing.get(k) ?? 0;
    if (s) out[k] = m ? { ...s, missing: m } : s;
  }
  return out;
}

/** A small seeded PRNG, so a bootstrap is repeatable. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

const median = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

/** The median of `xs` with a 90% bootstrap interval (1000 resamples). */
export function bootstrapMedian(xs: number[], rounds = 1000, seed = 7): { median: number; lo: number; hi: number } | undefined {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return undefined;
  const r = rng(seed);
  const meds: number[] = [];
  for (let i = 0; i < rounds; i++) meds.push(median(Array.from({ length: v.length }, () => v[Math.floor(r() * v.length)]!)));
  meds.sort((a, b) => a - b);
  return { median: median(v), lo: quantile(meds, 0.05), hi: quantile(meds, 0.95) };
}
