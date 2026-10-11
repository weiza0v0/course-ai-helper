/**
 * 概率统计：描述统计、组合计数、相关系数、线性回归、常见假设检验
 * 依赖 special.mjs（正态/t/χ²/F 分布）
 */
import * as S from './special.mjs';

const flat = x => (Array.isArray(x) ? x.flat(Infinity).map(Number) : [Number(x)]);
export const mean = x => { const a = flat(x); return a.reduce((s, v) => s + v, 0) / a.length; };
export const sum = x => flat(x).reduce((s, v) => s + v, 0);
export const prod = x => flat(x).reduce((s, v) => s * v, 1);
export const min = x => Math.min(...flat(x));
export const max = x => Math.max(...flat(x));

export function median(x) { return quantile(x, 0.5); }
export function quantile(x, q) {
  const a = flat(x).slice().sort((p, r) => p - r);
  if (!a.length) return NaN;
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
export function variance(x, sample = true) {
  const a = flat(x), m = mean(a), n = a.length;
  if (n - (sample ? 1 : 0) <= 0) return NaN;
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / (n - (sample ? 1 : 0));
}
export const stdev = (x, sample = true) => Math.sqrt(variance(x, sample));
export function cov(x, y, sample = true) {
  const a = flat(x), b = flat(y), n = a.length;
  if (a.length !== b.length) throw new Error('cov: 两组数据长度必须相同');
  const ma = mean(a), mb = mean(b);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - (sample ? 1 : 0));
}
export function pearson(x, y) {
  const a = flat(x), b = flat(y);
  const sx = stdev(a), sy = stdev(b);
  if (sx === 0 || sy === 0) return NaN;
  return cov(a, b) / (sx * sy);
}
export function spearman(x, y) {
  const rx = rank(x), ry = rank(y);
  return pearson(rx, ry);
}
function rank(x) {
  const a = flat(x);
  const idx = a.map((v, i) => [v, i]).sort((p, r) => p[0] - r[0]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
export function skewness(x) {
  const a = flat(x), n = a.length, m = mean(a), s = stdev(a);
  if (s === 0) return 0;
  return (n / ((n - 1) * (n - 2))) * a.reduce((t, v) => t + ((v - m) / s) ** 3, 0);
}
export function kurtosis(x) {
  const a = flat(x), n = a.length, m = mean(a), s = stdev(a);
  if (s === 0) return 0;
  const k = a.reduce((t, v) => t + ((v - m) / s) ** 4, 0) * n * (n + 1) / ((n - 1) * (n - 2) * (n - 3))
    - 3 * (n - 1) ** 2 / ((n - 2) * (n - 3));
  return k;
}
export function mode(x) {
  const cnt = new Map();
  for (const v of flat(x)) cnt.set(v, (cnt.get(v) || 0) + 1);
  let best = [], bn = 0;
  for (const [v, c] of cnt) { if (c > bn) { bn = c; best = [v]; } else if (c === bn) best.push(v); }
  return best.length === 1 ? best[0] : best;
}
export function describe(x) {
  const a = flat(x).slice().sort((p, r) => p - r);
  const n = a.length;
  return {
    n, mean: mean(a), median: median(a), mode: mode(a),
    variance_sample: variance(a, true), variance_population: variance(a, false),
    stdev_sample: stdev(a, true), stdev_population: stdev(a, false),
    min: a[0], max: a[n - 1], range: a[n - 1] - a[0],
    q1: quantile(a, 0.25), q3: quantile(a, 0.75),
    sum: sum(a),
  };
}

// ---------------------------------------------------------------- 组合计数
export function factorial(n) {
  if (n < 0 || !Number.isInteger(n)) return S.gamma(n + 1);
  if (n > 170) return Infinity;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}
export function comb(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return Math.round(Math.abs(r) > 1e15 ? r : r);
}
export function perm(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r *= (n - i);
  return r;
}

// ---------------------------------------------------------------- 回归
export function linreg(x, y) {
  const a = flat(x), b = flat(y), n = a.length;
  if (a.length !== b.length || n < 2) throw new Error('linreg: 需要等长的两组数据（≥2）');
  const mx = mean(a), my = mean(b);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = a[i] - mx, dy = b[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  const r2 = r * r;
  const sse = syy - slope * sxy;
  const se = Math.sqrt(sse / (n - 2));
  const seSlope = se / Math.sqrt(sxx);
  const t = slope / seSlope;
  const p = 2 * (1 - S.tCdf(Math.abs(t), n - 2));
  return {n, slope, intercept, r, r2, se, se_slope: seSlope, t, df: n - 2, p, sse};
}

// ---------------------------------------------------------------- 假设检验
export function ttestOne(data, mu0 = 0, tail = 'two') {
  const a = flat(data), n = a.length, m = mean(a), s = stdev(a, true);
  if (n < 2) throw new Error('ttest 至少需要 2 个数据');
  const se = s / Math.sqrt(n);
  const t = (m - mu0) / se;
  const df = n - 1;
  const p = pFromT(t, df, tail);
  const tc = S.tInv(1 - 0.05 / (tail === 'two' ? 2 : 1), df);
  const ci = [m - tc * se, m + tc * se];
  return {n, mean: m, sd: s, se, t, df, p, ci95: ci, mu0};
}
export function ttestTwo(a0, b0, {equalVar = false, tail = 'two'} = {}) {
  const a = flat(a0), b = flat(b0);
  const n1 = a.length, n2 = b.length, m1 = mean(a), m2 = mean(b), s1 = stdev(a, true), s2 = stdev(b, true);
  let df, se, t;
  if (equalVar) {
    df = n1 + n2 - 2;
    const sp2 = ((n1 - 1) * s1 * s1 + (n2 - 1) * s2 * s2) / df;
    se = Math.sqrt(sp2 * (1 / n1 + 1 / n2));
    t = (m1 - m2) / se;
  } else {
    const v1 = s1 * s1 / n1, v2 = s2 * s2 / n2;
    se = Math.sqrt(v1 + v2);
    t = (m1 - m2) / se;
    df = (v1 + v2) ** 2 / (v1 ** 2 / (n1 - 1) + v2 ** 2 / (n2 - 1));
  }
  return {n1, n2, mean1: m1, mean2: m2, sd1: s1, sd2: s2, se, t, df, p: pFromT(t, df, tail), method: equalVar ? 'pooled' : 'welch'};
}
export function ttestPaired(a0, b0) {
  const a = flat(a0), b = flat(b0);
  if (a.length !== b.length) throw new Error('配对检验要求两组数据一一对应');
  return ttestOne(a.map((v, i) => v - b[i]), 0);
}
export function ztest(data, mu0 = 0, sigma = null, tail = 'two') {
  const a = flat(data), n = a.length, m = mean(a), s = sigma ?? stdev(a, true);
  const se = s / Math.sqrt(n);
  const z = (m - mu0) / se;
  const p = tail === 'two' ? 2 * (1 - S.normCdf(Math.abs(z))) : tail === 'less' ? S.normCdf(z) : 1 - S.normCdf(z);
  return {n, mean: m, sigma: s, se, z, p};
}
export function chi2Gof(observed, expected = null) {
  const o = flat(observed);
  const total = sum(o);
  const e = expected ? flat(expected) : o.map(() => total / o.length);
  let chi2 = 0;
  for (let i = 0; i < o.length; i++) chi2 += (o[i] - e[i]) ** 2 / e[i];
  const df = o.length - 1;
  return {chi2, df, p: 1 - S.chi2Cdf(chi2, df), observed: o, expected: e};
}
export function chi2Independence(table) {
  const rows = table.length, cols = table[0].length;
  const rowSum = table.map(r => sum(r));
  const colSum = Array.from({length: cols}, (_, j) => sum(table.map(r => r[j])));
  const total = sum(rowSum);
  let chi2 = 0;
  const expected = table.map((r, i) => r.map((_, j) => rowSum[i] * colSum[j] / total));
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) chi2 += (table[i][j] - expected[i][j]) ** 2 / expected[i][j];
  const df = (rows - 1) * (cols - 1);
  return {chi2, df, p: 1 - S.chi2Cdf(chi2, df), expected};
}
export function anovaOneWay(groups) {
  const gs = groups.map(flat);
  const all = gs.flat();
  const k = gs.length, N = all.length;
  const gm = mean(all);
  const ssb = gs.reduce((s, g) => s + g.length * (mean(g) - gm) ** 2, 0);
  const ssw = gs.reduce((s, g) => s + g.reduce((t, v) => t + (v - mean(g)) ** 2, 0), 0);
  const dfb = k - 1, dfw = N - k;
  const msb = ssb / dfb, msw = ssw / dfw;
  const F = msb / msw;
  return {F, df_between: dfb, df_within: dfw, ss_between: ssb, ss_within: ssw, ms_between: msb, ms_within: msw, p: 1 - S.fCdf(F, dfb, dfw)};
}

function pFromT(t, df, tail) {
  if (tail === 'two') return 2 * (1 - S.tCdf(Math.abs(t), df));
  if (tail === 'less') return S.tCdf(t, df);
  return 1 - S.tCdf(t, df);
}

/** 贝叶斯：离散先验 + 似然 → 后验 */
export function bayes(priors, likelihoods) {
  const p = flat(priors), l = flat(likelihoods);
  if (p.length !== l.length) throw new Error('bayes: 先验与似然长度必须相同');
  const un = p.map((x, i) => x * l[i]);
  const z = sum(un);
  return {posterior: un.map(x => x / z), evidence: z};
}

export {S};
