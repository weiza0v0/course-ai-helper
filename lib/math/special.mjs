/**
 * 特殊函数：Γ、lnΓ、不完全 Γ、不完全 Beta、erf、正态/t/χ²/F 分布的 pdf/cdf/分位数
 * 数值方法参考 Numerical Recipes（级数 + 连分数），精度 ~1e-14
 */

export function gammaln(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
export function gamma(x) {
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  return Math.exp(gammaln(x));
}
export function beta(a, b) { return Math.exp(gammaln(a) + gammaln(b) - gammaln(a + b)); }
export function lbeta(a, b) { return gammaln(a) + gammaln(b) - gammaln(a + b); }

function gser(a, x) {
  let ap = a, sum = 1 / a, del = sum;
  for (let n = 1; n < 2000; n++) {
    ap++; del *= x / ap; sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
}
function gcf(a, x) {
  const FPMIN = 1e-300;
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 2000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
}
/** 正则化下不完全 Gamma P(a,x) */
export function gammap(a, x) {
  if (x <= 0) return 0;
  return x < a + 1 ? gser(a, x) : 1 - gcf(a, x);
}
export function gammaq(a, x) { return 1 - gammap(a, x); }

function betacf(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 2000; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
}
/** 正则化不完全 Beta I_x(a,b) */
export function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lbetaInv(a, b, x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
function lbetaInv(a, b, x) { return gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x); }

export function erf(x) {
  if (x === 0) return 0;
  // 关键恒等式：erf(x) = P(1/2, x²)（正则化下不完全 Gamma），不是 2P-1
  const v = gammap(0.5, x * x);
  return x > 0 ? v : -v;
}
export function erfc(x) { return 1 - erf(x); }

// ---------------------------------------------------------------- 正态
export function normPdf(x, mu = 0, sd = 1) {
  const z = (x - mu) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
}
export function normCdf(x, mu = 0, sd = 1) {
  const z = (x - mu) / (sd * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}
/** 标准正态分位数（Acklam 近似 + Halley 细化，精度 ~1e-15） */
export function normInv(p, mu = 0, sd = 1) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r, z;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); z = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p <= ph) { q = p - 0.5; r = q * q; z = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  else { q = Math.sqrt(-2 * Math.log(1 - p)); z = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  // Halley 修正
  const e = normCdf(z) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(z * z / 2);
  z = z - u / (1 + z * u / 2);
  return mu + sd * z;
}

// ---------------------------------------------------------------- t / χ² / F
export function tPdf(t, df) {
  return Math.exp(gammaln((df + 1) / 2) - gammaln(df / 2)) / Math.sqrt(df * Math.PI) * Math.pow(1 + t * t / df, -(df + 1) / 2);
}
export function tCdf(t, df) {
  const x = df / (df + t * t);
  const ib = betai(df / 2, 0.5, x);
  return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}
export function tInv(p, df) { return invertCdf(x => tCdf(x, df), p, -1e6, 1e6); }

export function chi2Pdf(x, k) {
  if (x <= 0) return 0;
  return Math.exp((k / 2 - 1) * Math.log(x) - x / 2 - (k / 2) * Math.LN2 - gammaln(k / 2));
}
export function chi2Cdf(x, k) { return x <= 0 ? 0 : gammap(k / 2, x / 2); }
export function chi2Inv(p, k) { return invertCdf(x => chi2Cdf(x, k), p, 0, 1e6); }

export function fPdf(F, d1, d2) {
  if (F <= 0) return 0;
  const l = (d1 / 2) * Math.log(d1) + (d2 / 2) * Math.log(d2) + (d1 / 2 - 1) * Math.log(F) - ((d1 + d2) / 2) * Math.log(d1 * F + d2) - lbeta(d1 / 2, d2 / 2);
  return Math.exp(l);
}
export function fCdf(F, d1, d2) {
  if (F <= 0) return 0;
  return betai(d1 / 2, d2 / 2, d1 * F / (d1 * F + d2));
}
export function fInv(p, d1, d2) { return invertCdf(x => fCdf(x, d1, d2), p, 0, 1e8); }

/** 二分法求 CDF 反函数（单调，稳） */
export function invertCdf(cdf, p, lo, hi) {
  if (p <= 0) return lo;
  if (p >= 1) return hi;
  let a = lo, b = hi;
  for (let i = 0; i < 200; i++) {
    const m = (a + b) / 2;
    if (cdf(m) < p) a = m; else b = m;
  }
  return (a + b) / 2;
}

// ---------------------------------------------------------------- 离散分布
export function binomPmf(k, n, p) {
  if (k < 0 || k > n) return 0;
  return Math.exp(gammaln(n + 1) - gammaln(k + 1) - gammaln(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}
export function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  return betai(n - k, k + 1, 1 - p);
}
export function poissonPmf(k, lambda) {
  if (k < 0) return 0;
  return Math.exp(-lambda + k * Math.log(lambda) - gammaln(k + 1));
}
export function poissonCdf(k, lambda) {
  if (k < 0) return 0;
  return gammaq(k + 1, lambda);
}
export function expPdf(x, lambda) { return x < 0 ? 0 : lambda * Math.exp(-lambda * x); }
export function expCdf(x, lambda) { return x < 0 ? 0 : 1 - Math.exp(-lambda * x); }
