"""用 numpy/scipy/sympy 生成数学参考值，供 test/math-test.mjs 交叉验证。
   python3 test/math-ref.py > test/math-ref.json
"""
import json
import numpy as np
from scipy import stats, linalg, integrate, optimize
import sympy as sp

R = {}

# ---------------- 线性代数
A1 = np.array([[1, 0, 2, 1], [0, -1, 3, -1], [-1, -1, 5, -1], [-1, 1, 4, 0]], dtype=float)
R["det_a"] = float(np.linalg.det(A1))
A2 = np.array([[1, 1, 1, 1], [16, 9, 49, 25], [4, 3, 7, -5], [64, 27, 343, -125]], dtype=float)
R["det_vand"] = float(np.linalg.det(A2))
A3 = np.array([[4, 7], [2, 6]], dtype=float)
R["inv"] = np.linalg.inv(A3).tolist()
A4 = np.array([[1, 2, 3], [0, 1, 4], [5, 6, 0]], dtype=float)
R["inv3"] = np.linalg.inv(A4).tolist()
A5 = np.array([[1, 2, 3], [2, 4, 6], [1, 1, 1]], dtype=float)
R["rank"] = int(np.linalg.matrix_rank(A5))
A6 = np.array([[2, 1], [1, 3]], dtype=float)
R["solve"] = np.linalg.solve(A6, np.array([3.0, 5.0])).tolist()
R["eigen_sym"] = sorted(np.linalg.eigvalsh(np.array([[2, 1], [1, 2]], dtype=float)).tolist())
R["eigen_rot"] = sorted([complex(x) for x in np.linalg.eigvals(np.array([[0, -1], [1, 0]], dtype=float))], key=lambda z: (z.real, z.imag))
R["eigen3"] = sorted(np.linalg.eigvals(np.array([[4, 1, 0], [1, 3, 1], [0, 1, 2]], dtype=float)).real.tolist())
M = np.array([[1, -2, 3], [-4, 5, -6], [7, -8, 9]], dtype=float)
R["norm_fro"] = float(np.linalg.norm(M, 'fro'))
R["norm_1"] = float(np.linalg.norm(M, 1))
R["norm_inf"] = float(np.linalg.norm(M, np.inf))
R["norm_2"] = float(np.linalg.norm(M, 2))
R["trace"] = float(np.trace(M))
R["mul"] = (np.array([[1, 2], [3, 4]]) @ np.array([[0, 1], [1, 0]])).tolist()
R["nullspace_dim"] = 3 - int(np.linalg.matrix_rank(np.array([[1, 2, 3], [2, 4, 6]], dtype=float)))
R["cond"] = float(np.linalg.cond(np.array([[1, 2], [3, 4]], dtype=float)))

# ---------------- 微积分（sympy）
x = sp.symbols('x')
def dval(expr, point, order=1):
    return float(sp.diff(sp.sympify(expr), x, order).subs(x, point))
R["d_poly_at2"] = dval('x**3 + 2*x', 2)
R["d_trig_at03"] = dval('sin(x)*cos(x)', 0.3)
R["d_chain_at07"] = dval('exp(sin(x))', 0.7)
R["d_quot_at2"] = dval('(x**2+1)/(x-1)', 2)
R["d_log_at1"] = dval('ln(x**2+1)', 1)
R["d2_poly_at2"] = dval('x**4 - 3*x**2', 2, 2)
R["d3"] = float(sp.diff(sp.sympify('x**5'), x, 3).subs(x, 1.5))
R["d_sqrt_at4"] = dval('sqrt(x)', 4)
R["int_poly"] = float(sp.integrate(x**2, (x, 0, 3)))
R["int_sin"] = float(sp.integrate(sp.sin(x), (x, 0, sp.pi)))
R["int_1x"] = float(sp.integrate(1/x, (x, 1, sp.E)))
R["int_exp"] = float(sp.integrate(sp.exp(x), (x, 0, 1)))
R["int_gauss"] = float(sp.integrate(sp.exp(-x**2), (x, 0, 1)))
R["int_abs"] = float(sp.integrate(sp.Abs(x), (x, -1, 1)))
R["int_xexp"] = float(sp.integrate(x*sp.exp(-x), (x, 0, 5)))
R["lim_sinc"] = 1.0
R["lim_e"] = float(np.e)
R["lim_1cos"] = 0.5
R["lim_inf"] = "inf"
R["roots_quad"] = sorted([float(r) for r in sp.solve(sp.sympify('x**2 - 5*x + 6'), x)])
R["roots_cubic"] = sorted([float(r) for r in sp.solve(sp.sympify('x**3 - x'), x)])
R["taylor_exp"] = [1/sp.factorial(n) for n in range(6)]
R["taylor_sin"] = [float(sp.diff(sp.sin(x), x, n).subs(x, 0)/sp.factorial(n)) for n in range(6)]
R["taylor_ln"] = [float(sp.diff(sp.ln(1+x), x, n).subs(x, 0)/sp.factorial(n)) for n in range(5)]
R["sum_1k2"] = float(sum(1/k**2 for k in range(1, 1001)))
R["sum_k2"] = float(sum(k**2 for k in range(1, 101)))
R["sum_geom"] = float(sum(0.5**k for k in range(0, 41)))

# ---------------- 统计（scipy）
data = [2, 4, 4, 4, 5, 5, 7, 9]
R["desc_mean"] = float(np.mean(data))
R["desc_median"] = float(np.median(data))
R["desc_sd"] = float(np.std(data, ddof=1))
R["desc_var_pop"] = float(np.var(data, ddof=0))
R["desc_q1"] = float(np.quantile(data, 0.25))
R["desc_q3"] = float(np.quantile(data, 0.75))
R["desc_skew"] = float(stats.skew(data, bias=False))
R["desc_kurt"] = float(stats.kurtosis(data, bias=False))

d1 = [1, 2, 3, 4, 5]
R["tt1_t"], R["tt1_p"] = [float(v) for v in stats.ttest_1samp(d1, 0)]
R["tt1_mean"] = float(np.mean(d1))
R["tt1_sd"] = float(np.std(d1, ddof=1))
g1 = [5.1, 4.9, 5.3, 5.0, 5.2]
g2 = [4.8, 4.6, 5.0, 4.7, 4.9]
R["tt2_welch_t"], R["tt2_welch_p"] = [float(v) for v in stats.ttest_ind(g1, g2, equal_var=False)]
R["tt2_pool_t"], R["tt2_pool_p"] = [float(v) for v in stats.ttest_ind(g1, g2, equal_var=True)]
p1 = [10, 12, 14, 16, 18]
p2 = [9, 11, 14, 14, 17]
R["ttp_t"], R["ttp_p"] = [float(v) for v in stats.ttest_rel(p1, p2)]
R["ztest_z"] = float((np.mean(d1) - 3) / (2/np.sqrt(5)))
R["ztest_p"] = float(2*(1-stats.norm.cdf(abs(R["ztest_z"]))))
obs = [10, 20, 30, 40]
R["chi2_gof"], R["chi2_gof_p"] = [float(v) for v in stats.chisquare(obs)]
R["chi2_gof_df"] = 3.0
tbl = [[10, 20], [30, 40]]
R["chi2_ind"], R["chi2_ind_p"], R["chi2_ind_df"] = [float(v) for v in stats.chi2_contingency(np.array(tbl), correction=False)[:3]]
rx = [1, 2, 3, 4, 5]
ry = [2, 4, 5, 4, 5]
lr = stats.linregress(rx, ry)
R["reg_slope"] = float(lr.slope)
R["reg_intercept"] = float(lr.intercept)
R["reg_r"] = float(lr.rvalue)
R["reg_r2"] = float(lr.rvalue**2)
R["reg_p"] = float(lr.pvalue)
R["reg_se_slope"] = float(lr.stderr)
R["corr_pearson"] = float(np.corrcoef(rx, ry)[0, 1])
R["corr_spearman"] = float(stats.spearmanr(rx, ry).statistic)
a1 = [1, 2, 3, 4]
a2 = [2, 4, 6, 8]
a3 = [1, 3, 5, 7]
R["anova_F"], R["anova_p"] = [float(v) for v in stats.f_oneway(a1, a2, a3)[:2]]

# ---------------- 分布
R["normcdf_196"] = float(stats.norm.cdf(1.96))
R["normcdf_1_2_3"] = float(stats.norm.cdf(1, loc=2, scale=3))
R["norminv_975"] = float(stats.norm.ppf(0.975))
R["normpdf_0"] = float(stats.norm.pdf(0))
R["tcdf_2228_10"] = float(stats.t.cdf(2.228, 10))
R["tinv_975_10"] = float(stats.t.ppf(0.975, 10))
R["tpdf_1_5"] = float(stats.t.pdf(1, 5))
R["chi2cdf_7815_3"] = float(stats.chi2.cdf(7.815, 3))
R["chi2inv_95_3"] = float(stats.chi2.ppf(0.95, 3))
R["fcdf_371_3_10"] = float(stats.f.cdf(3.71, 3, 10))
R["finv_95_3_10"] = float(stats.f.ppf(0.95, 3, 10))
R["binomcdf_5_10_half"] = float(stats.binom.cdf(5, 10, 0.5))
R["binompmf_3_10_half"] = float(stats.binom.pmf(3, 10, 0.5))
R["poissoncdf_2_3"] = float(stats.poisson.cdf(2, 3))
R["poissonpmf_2_3"] = float(stats.poisson.pmf(2, 3))
R["expcdf_1_2"] = float(stats.expon.cdf(1, scale=0.5))
R["gamma_5"] = float(sp.gamma(5))
R["lgamma_half"] = float(sp.loggamma(0.5))
R["beta_2_3"] = float(sp.beta(2, 3))
R["erf_1"] = float(sp.erf(1))
R["erfc_1"] = float(sp.erfc(1))
R["comb_10_3"] = float(sp.binomial(10, 3))
R["perm_10_3"] = float(sp.factorial(10)/sp.factorial(7))

# 非有限值转字符串，保证输出是合法 JSON
def sanitize(v):
    if isinstance(v, float):
        if v == float('inf'): return 'inf'
        if v == float('-inf'): return '-inf'
        if v != v: return 'nan'
        return v
    if isinstance(v, (list, tuple)): return [sanitize(x) for x in v]
    if isinstance(v, dict): return {k: sanitize(x) for k, x in v.items()}
    return v
print(json.dumps(sanitize(R), indent=1, default=str))
