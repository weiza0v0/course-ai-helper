/**
 * 数学层交叉验证：本项目的实现 vs numpy/scipy/sympy 生成的参考值
 *   python3 test/math-ref.py > test/math-ref.json    # 先生成参考值
 *   node test/math-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as L from '../lib/math/linalg.mjs';
import * as S from '../lib/math/special.mjs';
import * as T from '../lib/math/stats.mjs';
import * as C from '../lib/math/calculus.mjs';
import {toExpr} from '../lib/math/parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'math-ref.json'), 'utf8'));

let pass = 0, fail = 0;
const fails = [];
function chk(name, got, want, tol = 1e-9) {
  let ok;
  if (want === 'inf') ok = got === Infinity;
  else if (typeof want === 'number') ok = Number.isFinite(got) && Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  else if (Array.isArray(want)) {
    const g = flatten(got), w = flatten(want);
    ok = g.length === w.length && g.every((x, i) => Math.abs(x - Number(w[i])) <= tol * Math.max(1, Math.abs(Number(w[i]))));
  } else if (typeof want === 'string' && want.includes('/')) {
    const [a, b] = want.split('/').map(Number);
    ok = Math.abs(got - a / b) <= tol;
  } else ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; fails.push(`  ❌ ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`); }
}
const flatten = x => (Array.isArray(x) ? x.flat(Infinity).map(Number) : [Number(x)]);
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

console.log('\n数学层交叉验证（对照 numpy / scipy / sympy）\n' + '='.repeat(58));

// ================================================================ 线性代数
chk('det 4阶', L.det([[1, 0, 2, 1], [0, -1, 3, -1], [-1, -1, 5, -1], [-1, 1, 4, 0]]), R.det_a);
chk('det 范德蒙德', L.det([[1, 1, 1, 1], [16, 9, 49, 25], [4, 3, 7, -5], [64, 27, 343, -125]]), R.det_vand, 1e-6);
chk('inv 2x2', L.invert([[4, 7], [2, 6]]), R.inv, 1e-9);
chk('inv 3x3', L.invert([[1, 2, 3], [0, 1, 4], [5, 6, 0]]), R.inv3, 1e-8);
chk('rank', L.rank([[1, 2, 3], [2, 4, 6], [1, 1, 1]]), R.rank);
chk('trace', L.trace([[1, -2, 3], [-4, 5, -6], [7, -8, 9]]), R.trace);
chk('mul', L.matmul([[1, 2], [3, 4]], [[0, 1], [1, 0]]), R.mul);
chk('norm-fro', L.norm([[1, -2, 3], [-4, 5, -6], [7, -8, 9]], 'fro'), R.norm_fro, 1e-9);
chk('norm-1', L.norm([[1, -2, 3], [-4, 5, -6], [7, -8, 9]], 1), R.norm_1, 1e-9);
chk('norm-inf', L.norm([[1, -2, 3], [-4, 5, -6], [7, -8, 9]], 'inf'), R.norm_inf, 1e-9);
chk('norm-2(谱范数)', L.norm([[1, -2, 3], [-4, 5, -6], [7, -8, 9]], 2), R.norm_2, 1e-7);
chk('solve 2x2', L.solve([[2, 1], [1, 3]], [3, 5]), R.solve, 1e-10);
chk('solve 3x3', L.solve([[2, 1, -1], [-3, -1, 2], [-2, 1, 2]], [8, -11, -3]), [2, 3, -1], 1e-9);
chk('特征值(对称)', L.eigenvaluesReal([[2, 1], [1, 2]]).sort((a, b) => a - b), R.eigen_sym, 1e-8);
chk('特征值(实)', L.eigenvaluesReal([[4, 1, 0], [1, 3, 1], [0, 1, 2]]).sort((a, b) => a - b), R.eigen3, 1e-6);
{
  const es = L.eigenvalues([[0, -1], [1, 0]]);
  const okc = es.length === 2 && es.every(e => Math.abs(e.re) < 1e-9) && close(Math.abs(es[0].im), 1, 1e-8) && close(Math.abs(es[1].im), 1, 1e-8);
  chk('特征值(复根 ±i)', okc, true);
}
{
  const A = [[1, 2], [3, 4]];
  const {L: Lm, U, P} = L.lu(A);
  const PA = L.matmul(P, A), LU = L.matmul(Lm, U);
  chk('LU 分解 PA=LU', flatten(LU).every((v, i) => close(v, flatten(PA)[i], 1e-9)), true);
}
{
  const A = [[1, 1, 0], [0, 1, 1], [1, 0, 1]];
  const {Q, R: Rm} = L.qr(A);
  const QR = L.matmul(Q, Rm);
  const QtQ = L.matmul(L.transpose(Q), Q);
  const I = L.eye(3);
  chk('QR: QR=A', flatten(QR).every((v, i) => close(v, flatten(A)[i], 1e-8)), true);
  chk('QR: Q^TQ=I', flatten(QtQ).every((v, i) => close(v, flatten(I)[i], 1e-8)), true);
}
chk('零空间维数', L.nullspace([[1, 2, 3], [2, 4, 6]]).length, R.nullspace_dim);

// ================================================================ 微积分
const dAt = (expr, p, order = 1) => C.evaluateAt(toExpr(C.derivative(expr, 'x', order)), 'x', p);
chk('求导 x³+2x @2', dAt('x^3+2x', 2), R.d_poly_at2, 1e-8);
chk('求导 sin·cos @0.3', dAt('sin(x)*cos(x)', 0.3), R.d_trig_at03, 1e-8);
chk('链式 exp(sin x) @0.7', dAt('exp(sin(x))', 0.7), R.d_chain_at07, 1e-7);
chk('商法则 (x²+1)/(x-1) @2', dAt('(x^2+1)/(x-1)', 2), R.d_quot_at2, 1e-8);
chk('求导 ln(x²+1) @1', dAt('ln(x^2+1)', 1), R.d_log_at1, 1e-8);
chk('二阶导 x⁴-3x² @2', dAt('x^4-3x^2', 2, 2), R.d2_poly_at2, 1e-7);
chk('三阶导 x⁵ @1.5', dAt('x^5', 1.5, 3), R.d3, 1e-6);
chk('求导 sqrt(x) @4', dAt('sqrt(x)', 4), R.d_sqrt_at4, 1e-8);

const intOf = (expr, a, b) => { const {f} = C.compile(expr); return C.integrateNumeric(v => f({x: v}), a, b); };
chk('定积分 ∫₀³x²', intOf('x^2', 0, 3), R.int_poly, 1e-9);
chk('定积分 ∫₀^π sin', intOf('sin(x)', 0, Math.PI), R.int_sin, 1e-9);
chk('定积分 ∫₁^e 1/x', intOf('1/x', 1, Math.E), R.int_1x, 1e-8);
chk('定积分 ∫₀¹ eˣ', intOf('exp(x)', 0, 1), R.int_exp, 1e-9);
chk('定积分 ∫₀¹ e^(-x²)', intOf('exp(-x^2)', 0, 1), R.int_gauss, 1e-9);
chk('定积分 ∫₋₁¹ |x|', intOf('abs(x)', -1, 1), R.int_abs, 1e-8);
chk('定积分 ∫₀⁵ x·e⁻ˣ', intOf('x*exp(-x)', 0, 5), R.int_xexp, 1e-9);
{
  const sym = C.integrateSymbolic('x^3+2x', 'x');
  chk('符号积分返回原函数', !!sym, true);
  if (sym) {
    const F = x => C.evaluateAt(toExpr(sym), 'x', x);
    chk('符号积分 微积分基本定理校验', F(2) - F(0), 8, 1e-9);
  }
}
chk('极限 sin(x)/x → 0', C.limit('sin(x)/x', 'x', 0).value, R.lim_sinc, 1e-8);
chk('极限 (1+1/x)^x → ∞', C.limit('(1+1/x)^x', 'x', 1e9).value, R.lim_e, 1e-6);
chk('极限 (1-cos x)/x² → 0', C.limit('(1-cos(x))/x^2', 'x', 0).value, R.lim_1cos, 1e-8);
chk('极限 1/x → ∞ (单侧)', C.limit('1/x', 'x', 0, '+').value, 'inf');
chk('求根 x²-5x+6', C.findRoots('x^2-5*x+6', 'x'), R.roots_quad, 1e-8);
chk('求根 x³-x', C.findRoots('x^3-x', 'x'), R.roots_cubic, 1e-8);
chk('求根（带等号写法）', C.findRoots('x^2-5x+6=0', 'x'), R.roots_quad, 1e-8);
{
  const tz = C.taylor('exp(x)', 'x', {at: 0, order: 5}).terms.map(t => t.coefficient);
  chk('Taylor exp(x) 系数', tz, R.taylor_exp.slice(0, 6).map(v => (typeof v === 'string' ? eval(v) : v)), 1e-9);
  const ts = C.taylor('sin(x)', 'x', {at: 0, order: 5}).terms.map(t => t.coefficient);
  chk('Taylor sin(x) 系数', ts, R.taylor_sin, 1e-9);
  const tl = C.taylor('ln(1+x)', 'x', {at: 0, order: 4}).terms.map(t => t.coefficient);
  chk('Taylor ln(1+x) 系数', tl, R.taylor_ln, 1e-9);
}
chk('级数 Σ1/k² (k=1..1000)', C.seriesSum('1/k^2', 'k', 1, 1000).sum, R.sum_1k2, 1e-12);
chk('级数 Σk² (k=1..100)', C.seriesSum('k^2', 'k', 1, 100).sum, R.sum_k2, 1e-9);
chk('级数 Σ(1/2)^k (k=0..40)', C.seriesSum('(1/2)^k', 'k', 0, 40).sum, R.sum_geom, 1e-9);

// ================================================================ 统计
const data = [2, 4, 4, 4, 5, 5, 7, 9];
const desc = T.describe(data);
chk('描述统计 mean', desc.mean, R.desc_mean, 1e-12);
chk('描述统计 median', desc.median, R.desc_median, 1e-12);
chk('描述统计 样本标准差', desc.stdev_sample, R.desc_sd, 1e-12);
chk('描述统计 总体方差', desc.variance_population, R.desc_var_pop, 1e-12);
chk('描述统计 Q1', desc.q1, R.desc_q1, 1e-12);
chk('描述统计 Q3', desc.q3, R.desc_q3, 1e-12);
chk('描述统计 偏度', T.skewness(data), R.desc_skew, 1e-9);
chk('描述统计 峰度', T.kurtosis(data), R.desc_kurt, 1e-6);

const d1 = [1, 2, 3, 4, 5];
const tt = T.ttestOne(d1, 0);
chk('单样本 t 统计量', tt.t, R.tt1_t, 1e-9);
chk('单样本 t 的 p 值', tt.p, R.tt1_p, 1e-9);
chk('单样本 均值', tt.mean, R.tt1_mean, 1e-12);
const g1 = [5.1, 4.9, 5.3, 5.0, 5.2], g2 = [4.8, 4.6, 5.0, 4.7, 4.9];
const w = T.ttestTwo(g1, g2, {equalVar: false});
chk('Welch t', w.t, R.tt2_welch_t, 1e-9);
chk('Welch p', w.p, R.tt2_welch_p, 1e-9);
const pw = T.ttestTwo(g1, g2, {equalVar: true});
chk('合并方差 t', pw.t, R.tt2_pool_t, 1e-9);
chk('合并方差 p', pw.p, R.tt2_pool_p, 1e-9);
const pr = T.ttestPaired([10, 12, 14, 16, 18], [9, 11, 14, 14, 17]);
chk('配对 t', pr.t, R.ttp_t, 1e-9);
chk('配对 p', pr.p, R.ttp_p, 1e-9);
const z = T.ztest(d1, 3, 2);
chk('z 统计量', z.z, R.ztest_z, 1e-9);
chk('z 的 p 值', z.p, R.ztest_p, 1e-9);
const cg = T.chi2Gof([10, 20, 30, 40]);
chk('卡方拟合优度 χ²', cg.chi2, R.chi2_gof, 1e-9);
chk('卡方拟合优度 p', cg.p, R.chi2_gof_p, 1e-9);
const ci = T.chi2Independence([[10, 20], [30, 40]]);
chk('卡方独立性 χ²', ci.chi2, R.chi2_ind, 1e-9);
chk('卡方独立性 p', ci.p, R.chi2_ind_p, 1e-9);
chk('卡方独立性 df', ci.df, R.chi2_ind_df);
const rg = T.linreg([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]);
chk('回归 斜率', rg.slope, R.reg_slope, 1e-9);
chk('回归 截距', rg.intercept, R.reg_intercept, 1e-9);
chk('回归 r', rg.r, R.reg_r, 1e-9);
chk('回归 p', rg.p, R.reg_p, 1e-8);
chk('回归 斜率标准误', rg.se_slope, R.reg_se_slope, 1e-9);
chk('Pearson 相关', T.pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]), R.corr_pearson, 1e-12);
chk('Spearman 相关', T.spearman([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]), R.corr_spearman, 1e-9);
const an = T.anovaOneWay([[1, 2, 3, 4], [2, 4, 6, 8], [1, 3, 5, 7]]);
chk('单因素方差分析 F', an.F, R.anova_F, 1e-9);
chk('单因素方差分析 p', an.p, R.anova_p, 1e-9);

// ================================================================ 分布与特殊函数
chk('normcdf(1.96)', S.normCdf(1.96), R.normcdf_196, 1e-12);
chk('normcdf(1,μ=2,σ=3)', S.normCdf(1, 2, 3), R.normcdf_1_2_3, 1e-12);
chk('norminv(0.975)', S.normInv(0.975), R.norminv_975, 1e-11);
chk('normpdf(0)', S.normPdf(0), R.normpdf_0, 1e-12);
chk('tcdf(2.228,10)', S.tCdf(2.228, 10), R.tcdf_2228_10, 1e-10);
chk('tinv(0.975,10)', S.tInv(0.975, 10), R.tinv_975_10, 1e-8);
chk('tpdf(1,5)', S.tPdf(1, 5), R.tpdf_1_5, 1e-12);
chk('chi2cdf(7.815,3)', S.chi2Cdf(7.815, 3), R.chi2cdf_7815_3, 1e-10);
chk('chi2inv(0.95,3)', S.chi2Inv(0.95, 3), R.chi2inv_95_3, 1e-8);
chk('fcdf(3.71,3,10)', S.fCdf(3.71, 3, 10), R.fcdf_371_3_10, 1e-10);
chk('finv(0.95,3,10)', S.fInv(0.95, 3, 10), R.finv_95_3_10, 1e-7);
chk('binomcdf(5,10,0.5)', S.binomCdf(5, 10, 0.5), R.binomcdf_5_10_half, 1e-12);
chk('binompmf(3,10,0.5)', S.binomPmf(3, 10, 0.5), R.binompmf_3_10_half, 1e-12);
chk('poissoncdf(2,3)', S.poissonCdf(2, 3), R.poissoncdf_2_3, 1e-12);
chk('poissonpmf(2,3)', S.poissonPmf(2, 3), R.poissonpmf_2_3, 1e-12);
chk('expcdf(1,λ=2)', S.expCdf(1, 2), R.expcdf_1_2, 1e-12);
chk('Γ(5)', S.gamma(5), R.gamma_5, 1e-10);
chk('lnΓ(0.5)', S.gammaln(0.5), R.lgamma_half, 1e-12);
chk('B(2,3)', S.beta(2, 3), R.beta_2_3, 1e-12);
chk('erf(1)', S.erf(1), R.erf_1, 1e-12);
chk('erfc(1)', S.erfc(1), R.erfc_1, 1e-12);
chk('C(10,3)', T.comb(10, 3), R.comb_10_3);
chk('P(10,3)', T.perm(10, 3), R.perm_10_3);

// ================================================================ 结果
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
if (fails.length) { console.log('\n失败详情：'); console.log(fails.join('\n')); }
else console.log('  ✅ 全部与 numpy/scipy/sympy 一致\n');
process.exitCode = fail ? 1 : 0;
