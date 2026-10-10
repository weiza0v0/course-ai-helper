/**
 * 表达式里可用的函数表（calc 工具的"标准库"）
 * 覆盖：初等数学 / 线性代数 / 概率统计 / 计数 / 分布
 * 所有函数只接受"已求值"的普通数字或数组，不做字符串求值。
 */
import * as L from './linalg.mjs';
import * as T from './stats.mjs';
import * as S from './special.mjs';

const M = Math;
const D2R = Math.PI / 180;

export function makeFunctions() {
  return {
    // ---------------- 初等数学
    sin: M.sin, cos: M.cos, tan: M.tan,
    asin: M.asin, acos: M.acos, atan: M.atan, atan2: M.atan2,
    sinh: M.sinh, cosh: M.cosh, tanh: M.tanh,
    asinh: M.asinh, acosh: M.acosh, atanh: M.atanh,
    sec: x => 1 / M.cos(x), csc: x => 1 / M.sin(x), cot: x => 1 / M.tan(x),
    sqrt: M.sqrt, cbrt: M.cbrt, abs: M.abs, exp: M.exp, pow: M.pow, hypot: M.hypot,
    ln: M.log, log: (x, b) => (b === undefined ? M.log(x) : M.log(x) / M.log(b)),
    log10: M.log10, log2: M.log2, expm1: M.expm1, log1p: M.log1p,
    floor: M.floor, ceil: M.ceil, trunc: M.trunc, sign: M.sign,
    round: (x, d = 0) => { const k = 10 ** d; return M.round(x * k) / k; },
    min: (...a) => M.min(...a.flat(Infinity)), max: (...a) => M.max(...a.flat(Infinity)),
    mod: (a, b) => ((a % b) + b) % b, gcd: (a, b) => { a = M.abs(a); b = M.abs(b); while (b) { [a, b] = [b, a % b]; } return a; },
    lcm: (a, b) => M.abs(a * b) / (function g(x, y) { x = M.abs(x); y = M.abs(y); while (y) { [x, y] = [y, x % y]; } return x; })(a, b),
    clamp: (x, lo, hi) => M.min(M.max(x, lo), hi),
    deg: r => r / D2R, rad: d => d * D2R,
    gamma: S.gamma, lgamma: S.gammaln, beta: S.beta, lbeta: S.lbeta,
    erf: S.erf, erfc: S.erfc,

    // ---------------- 线性代数
    det: L.det, inv: L.invert, inverse: L.invert, rank: L.rank, trace: L.trace,
    transpose: L.transpose, tr: L.transpose,
    matmul: L.matmul, mmul: L.matmul, hadamard: (A, B) => A.map((r, i) => r.map((x, j) => x * B[i][j])), emul: (A, B) => A.map((r, i) => r.map((x, j) => x * B[i][j])),
    dot: (...v) => v.map(x => (L.isMatrix(x) ? x.flat() : x)).reduce((a, b) => L.dot(a, b)),
    cross: L.cross,
    norm: L.norm, solve: L.solve, lu: L.lu, qr: L.qr, nullspace: L.nullspace,
    rref: A => L.rref(A).rref, pivots: A => L.rref(A).pivots,
    eigen: A => L.eigenvalues(A), eigvals: A => L.eigenvalues(A),
    eigenReal: A => L.eigenvaluesReal(A),
    identity: L.eye, eye: L.eye, zeros: L.zeros, ones: (n, m = n) => L.zeros(n, m).map(r => r.map(() => 1)),
    diag: L.diag, shape: L.shape,
    sum: T.sum, prod: T.prod,

    // ---------------- 概率统计
    mean: T.mean, avg: T.mean, median: T.median, mode: T.mode,
    variance: T.variance, var: T.variance, stdev: T.stdev, std: T.stdev, sd: T.stdev,
    cov: T.cov, corr: T.pearson, pearson: T.pearson, spearman: T.spearman,
    skewness: T.skewness, kurtosis: T.kurtosis,
    quantile: (x, q) => T.quantile(x, q > 1 ? q / 100 : q),
    percentile: (x, p) => T.quantile(x, p / 100),
    iqr: x => T.quantile(x, 0.75) - T.quantile(x, 0.25),
    range: x => T.max(x) - T.min(x),

    // ---------------- 计数
    factorial: T.factorial, fact: T.factorial,
    comb: T.comb, choose: T.comb, C: T.comb,
    perm: T.perm, P: T.perm,

    // ---------------- 分布
    normalpdf: S.normPdf, normpdf: S.normPdf,
    normalcdf: S.normCdf, normcdf: S.normCdf,
    normalinv: S.normInv, norminv: S.normInv, zinv: S.normInv,
    tpdf: S.tPdf, tcdf: S.tCdf, tinv: S.tInv,
    chi2pdf: S.chi2Pdf, chi2cdf: S.chi2Cdf, chi2inv: S.chi2Inv,
    fpdf: S.fPdf, fcdf: S.fCdf, finv: S.fInv,
    binompmf: S.binomPmf, binompdf: S.binomPmf, binomcdf: S.binomCdf,
    poissonpmf: S.poissonPmf, poissonpdf: S.poissonPmf, poissoncdf: S.poissonCdf,
    exppdf: S.expPdf, expcdf: S.expCdf,
  };
}

export const FUNCTION_NAMES = Object.keys(makeFunctions());
