/**
 * 工具集
 *   web_search / web_fetch  —— 联网
 *   calc       —— 通用表达式求值（初等数学 / 线代 / 统计 / 分布 全套函数）
 *   matrix     —— 结构化线性代数（行列式、逆、秩、RREF、解方程组、特征值、LU/QR、零空间）
 *   calculus   —— 符号求导、符号/数值积分、极限、求根、Taylor、级数求和
 *   stats      —— 描述统计、分布、假设检验、回归
 * 计算全部本地完成，零依赖，无 eval / new Function。
 */

import {parse, evaluate, createContext, toExpr} from './math/parser.mjs';
import {makeFunctions, FUNCTION_NAMES} from './math/functions.mjs';
import * as L from './math/linalg.mjs';
import * as CALC from './math/calculus.mjs';
import * as ST from './math/stats.mjs';
import * as SP from './math/special.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TIMEOUT = 20000;
const FUNCS = makeFunctions();

// ================================================================ 工具声明
export const toolSpecs = [
  {
    type: 'function',
    function: {
      name: 'calc',
      description: [
        '数学计算器（求值），支持向量/矩阵字面量和一整套内置函数。凡是要下结论的数值，都用它算一遍，不要心算。',
        '运算：+ - * / % ^（^ 是乘方，也接受 **），pi、e、inf；隐式乘法 2x、3(x+1) 都能识别。',
        '向量 [1,2,3]、矩阵 [[1,2],[3,4]]；矩阵 * 矩阵 = 矩阵乘，向量 * 向量 = 点积。',
        '线性代数：det inv rank rref trace transpose matmul hadamard dot cross norm solve eigen lu qr nullspace identity/eye zeros ones diag pivots shape。',
        '统计分布：mean median var/stdev cov corr spearman quantile percentile iqr skewness kurtosis；',
        'normalpdf/normalcdf/normalinv tpdf/tcdf/tinv chi2pdf/chi2cdf/chi2inv fpdf/fcdf/finv binompmf/binomcdf poissonpmf/poissoncdf expcdf；',
        '计数：factorial comb/C perm/P；特殊函数：gamma lgamma beta erf erfc；初等：sin cos tan asin acos atan ln log log10 log2 sqrt cbrt exp abs floor ceil round hypot mod gcd lcm。',
        '例：det([[1,2],[3,4]])、inv([[4,7],[2,6]])、normalcdf(1.96)、comb(10,3)、mean([1,2,3,4])。',
        '需要传入符号量时用 vars，例如 {"expression":"a+b+d","vars":{"a":1,"b":2,"d":3}}。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          expression: {type: 'string', description: '要计算的表达式'},
          vars: {type: 'object', description: '可选：表达式里用到的变量的值，如 {"a":1,"b":2}'},
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'matrix',
      description: [
        '矩阵/线性代数专用工具（比 calc 返回更详细的结构化结果，含中间量）。',
        'op 取值：det 行列式 | inv 逆 | rank 秩 | rref 行简化阶梯形(含主元列) | trace 迹 | transpose 转置 |',
        'mul 矩阵乘 | add 加 | sub 减 | solve 解 Ax=b（b 放参数 b）| eigen 特征值(支持复数) | lu LU分解 | qr QR分解 |',
        'nullspace 零空间基 | norm 范数(type: fro/1/2/inf) | pow 幂 | shape 维数 | diag 对角。',
        'a、b 既可以是数组 [[1,2],[3,4]]，也可以是字符串 "[[1,2],[3,4]]"（内部用解析器解析）。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          op: {type: 'string', description: '操作名，见描述'},
          a: {description: '矩阵 A：数组或字符串'},
          b: {description: '可选：第二个矩阵/向量 b（solve 的右端项、mul 的右乘矩阵等）'},
          type: {type: 'string', description: 'norm 的范数类型：fro（默认）/1/2/inf'},
          k: {type: 'number', description: 'pow 的指数'},
        },
        required: ['op', 'a'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculus',
      description: [
        '微积分工具。op 取值：',
        'derivative 符号求导（可给 order 求高阶；给 at 则同时给出该点导数值）|',
        'integrate 积分（给 lower/upper 就是定积分，用自适应 Simpson 数值算；不给则是符号不定积分，能力有限，失败会退回数值）|',
        'limit 极限（给 point、dir: both/+/-）| solve 求根（表达式可写 "x^2-5x+6=0"，返回区间内所有实根）|',
        'taylor Taylor 展开（at 展开点、order 阶数）| sum 级数求和（from/to，变量默认 k）| simplify 化简 | eval 代入求值（point）。',
        '变量默认 x（sum 默认 k），用 variable 指定。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          op: {type: 'string', description: 'derivative / integrate / limit / solve / taylor / sum / simplify / eval'},
          expr: {type: 'string', description: '表达式，如 "x^3+2x"、"sin(x)/x"、"x^2-5x+6=0"'},
          variable: {type: 'string', description: '变量名，默认 x（sum 默认 k）'},
          order: {type: 'number', description: 'derivative 的阶数 / taylor 的阶数'},
          at: {type: 'number', description: 'derivative 求值点 / taylor 展开点'},
          point: {type: 'number', description: 'limit 的趋近点 / eval 的代入点'},
          dir: {type: 'string', description: 'limit 方向：both（默认）/ + / -'},
          lower: {type: 'number', description: 'integrate 下限'},
          upper: {type: 'number', description: 'integrate 上限'},
          from: {type: 'number', description: 'sum 起始'},
          to: {type: 'number', description: 'sum 结束'},
          lo: {type: 'number', description: 'solve 搜索下界（默认 -50）'},
          hi: {type: 'number', description: 'solve 搜索上界（默认 50）'},
        },
        required: ['op', 'expr'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stats',
      description: [
        '概率统计工具。op 取值：',
        'describe 描述统计(data) | dist 分布取值(dist=normal/t/chi2/f/binom/poisson/exp, kind=pdf/cdf/quantile, x, 以及参数) |',
        'ttest 单样本(data,mu)或双样本(a,b，equally paired=true 做配对，equalVar=true 做合并方差) | ztest(data,mu,sigma) |',
        'chisq 卡方检验(observed 或 table 列联表) | anova 单因素方差分析(groups) | regress 一元线性回归(x,y) |',
        'corr 相关系数(x,y,method=pearson/spearman) | comb/perm 组合排列(n,k) | bayes 贝叶斯(priors,likelihoods)。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          op: {type: 'string', description: 'describe / dist / ttest / ztest / chisq / anova / regress / corr / comb / perm / bayes'},
          data: {type: 'array', items: {type: 'number'}, description: '样本数据'},
          a: {type: 'array', items: {type: 'number'}, description: '第一组样本'},
          b: {type: 'array', items: {type: 'number'}, description: '第二组样本'},
          x: {type: 'array', items: {type: 'number'}, description: '自变量'},
          y: {type: 'array', items: {type: 'number'}, description: '因变量'},
          groups: {type: 'array', description: '多组样本（anova）'},
          observed: {type: 'array', items: {type: 'number'}, description: '观测频数（chisq）'},
          expected: {type: 'array', items: {type: 'number'}, description: '期望频数（chisq，可省）'},
          table: {type: 'array', description: '列联表（chisq）'},
          dist: {type: 'string', description: '分布名：normal/t/chi2/f/binom/poisson/exp'},
          kind: {type: 'string', description: 'pdf / cdf / quantile'},
          x0: {type: 'number', description: 'dist 的自变量取值（quantile 时是概率）'},
          params: {type: 'object', description: '分布参数，如 {"mu":0,"sigma":1} 或 {"n":10,"p":0.5} 或 {"df":5} 或 {"lambda":3}'},
          mu: {type: 'number', description: 'ttest/ztest 的原假设均值'},
          sigma: {type: 'number', description: 'ztest 的已知标准差'},
          tail: {type: 'string', description: 'two / less / greater'},
          paired: {type: 'boolean', description: 'ttest 是否配对'},
          equalVar: {type: 'boolean', description: 'ttest 是否合并方差'},
          n: {type: 'number'}, k: {type: 'number'},
          priors: {type: 'array', items: {type: 'number'}},
          likelihoods: {type: 'array', items: {type: 'number'}},
          method: {type: 'string', description: 'corr 的方法：pearson（默认）/spearman'},
        },
        required: ['op'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索（Bing 优先，DuckDuckGo 兜底）。用于查证定义、定理、公式、题目出处。',
      parameters: {
        type: 'object',
        properties: {
          query: {type: 'string', description: '搜索关键词，中文即可'},
          max_results: {type: 'integer', description: '返回条数，默认 5，最大 10'},
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取指定 URL 的网页正文（已去标签）。用于打开搜索结果里的页面精读。',
      parameters: {
        type: 'object',
        properties: {
          url: {type: 'string', description: '完整 http/https 链接'},
          max_chars: {type: 'integer', description: '最多返回多少字符，默认 6000'},
        },
        required: ['url'],
      },
    },
  },
];

// ================================================================ 格式化
const fmtNum = x => {
  if (!Number.isFinite(x)) return String(x);
  const r = Math.round(x);
  if (Math.abs(x - r) < 1e-12 && Math.abs(x) < 1e15) return String(r);
  if (Math.abs(x) !== 0 && (Math.abs(x) < 1e-4 || Math.abs(x) > 1e15)) return x.toExponential(10);
  return String(Number(x.toPrecision(12)));
};
function fmt(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) {
    if (v.length && Array.isArray(v[0])) {
      if (v[0].length && typeof v[0][0] === 'object' && v[0][0] !== null) return '\n' + v.map(r => pad + '  ' + r.map(x => JSON.stringify(x)).join(', ')).join('\n');
      return '\n' + v.map(r => pad + '  [ ' + r.map(fmtNum).join(',  ') + ' ]').join('\n');
    }
    return '[ ' + v.map(x => (typeof x === 'number' ? fmtNum(x) : JSON.stringify(x))).join(', ') + ' ]';
  }
  if (typeof v === 'object') return JSON.stringify(v, (k, val) => (typeof val === 'number' ? Number(val.toPrecision(12)) : val));
  return String(v);
}
function asMatrix(x, name = 'a') {
  if (typeof x === 'string') {
    const v = evaluate(parse(x), createContext({vars: {}, funcs: FUNCS}));
    if (!Array.isArray(v)) throw new Error(`${name} 解析出来不是数组`);
    return v;
  }
  if (Array.isArray(x)) return x;
  throw new Error(`${name} 必须是数组或数组字面量字符串`);
}

// ================================================================ calc
export function calc({expression, vars = {}} = {}) {
  const expr = String(expression == null ? '' : expression).trim();
  if (!expr) return '错误：expression 不能为空';
  if (expr.length > 4000) return '错误：表达式过长';
  const cleanVars = {};
  for (const [k, v] of Object.entries(vars || {})) {
    if (!/^[A-Za-z_\u0370-\u03ff][A-Za-z0-9_\u0370-\u03ff]*$/.test(k)) continue;
    cleanVars[k] = v;
  }
  try {
    const ast = parse(expr);
    const v = evaluate(ast, createContext({vars: cleanVars, funcs: FUNCS}));
    return `表达式：${expr}\n结果：${fmt(v, 0)}`;
  } catch (e) {
    return `计算失败：${e.message}`;
  }
}

// ================================================================ matrix
export function matrixTool(args = {}) {
  const {op} = args;
  try {
    const a = asMatrix(args.a, 'a');
    const b = args.b !== undefined ? asMatrix(args.b, 'b') : undefined;
    switch (op) {
      case 'det': return `A =\n${fmt(a, 0)}\ndet(A) = ${fmtNum(L.det(a))}`;
      case 'inv': case 'inverse': return `A^-1 =\n${fmt(L.invert(a), 0)}`;
      case 'rank': return `rank(A) = ${L.rank(a)}`;
      case 'rref': {
        const r = L.rref(a);
        return `rref(A) =\n${fmt(r.rref, 0)}\n主元列(从 0 开始)：${JSON.stringify(r.pivots)}\n秩 = ${r.rank}`;
      }
      case 'trace': return `trace(A) = ${fmtNum(L.trace(a))}`;
      case 'transpose': return `A^T =\n${fmt(L.transpose(a), 0)}`;
      case 'shape': return `shape(A) = ${JSON.stringify(L.shape(a))}`;
      case 'diag': return `diag ->\n${fmt(L.diag(a), 0)}`;
      case 'mul': case 'matmul': return `A·B =\n${fmt(L.matmul(a, b), 0)}`;
      case 'add': case 'sub': return `${op === 'add' ? 'A+B' : 'A-B'} =\n${fmt(op === 'add' ? L.add(a, b) : L.sub(a, b), 0)}`;
      case 'pow': return `A^${args.k} =\n${fmt(evaluate(parse(`a^${Number(args.k)}`), createContext({vars: {a}, funcs: FUNCS})), 0)}`;
      case 'norm': return `||A||_${args.type || 'fro'} = ${fmtNum(L.norm(a, args.type || 'fro'))}`;
      case 'solve': {
        if (b === undefined) throw new Error('solve 需要参数 b（右端项）');
        return `解 x =\n${fmt(L.solve(a, b), 0)}\n验证 A·x - b =\n${fmt(L.sub(L.matmul(a, L.isMatrix(b) ? b : b.map(x => [x])).map(r => r[0]), b), 0)}`;
      }
      case 'eigen': case 'eigvals': {
        const es = L.eigenvalues(a);
        const allReal = es.every(e => Math.abs(e.im) < 1e-9);
        const lines = es.map((e, i) => `  λ${i + 1} = ${Math.abs(e.im) < 1e-9 ? fmtNum(e.re) : `${fmtNum(e.re)} ${e.im >= 0 ? '+' : '-'} ${fmtNum(Math.abs(e.im))}i`}`);
        return `特征值：\n${lines.join('\n')}\n（${allReal ? '全部为实根' : '含复根'}）`;
      }
      case 'lu': { const r = L.lu(a); return `L =\n${fmt(r.L, 0)}\nU =\n${fmt(r.U, 0)}\nP =\n${fmt(r.P, 0)}`; }
      case 'qr': { const r = L.qr(a); return `Q =\n${fmt(r.Q, 0)}\nR =\n${fmt(r.R, 0)}`; }
      case 'nullspace': {
        const ns = L.nullspace(a);
        return ns.length ? `零空间基（${ns.length} 维）：\n${ns.map(v => '  ' + fmt(v)).join('\n')}` : '零空间只有零向量（列满秩）';
      }
      default: return `未知 op "${op}"。可用：det inv rank rref trace transpose mul add sub solve eigen lu qr nullspace norm pow shape diag`;
    }
  } catch (e) {
    return `matrix 执行失败：${e.message}`;
  }
}

// ================================================================ calculus
export function calculusTool(args = {}) {
  const {op} = args;
  const expr = String(args.expr == null ? '' : args.expr);
  const variable = args.variable || (op === 'sum' ? 'k' : 'x');
  try {
    switch (op) {
      case 'derivative': case 'diff': {
        const order = Math.max(1, Math.min(10, Number(args.order) || 1));
        const dAst = CALC.derivative(expr, variable, order);
        const text = toExpr(dAst);
        let extra = '';
        if (args.at !== undefined) {
          const val = CALC.evaluateAt(text, variable, Number(args.at));
          extra = `\n在 ${variable} = ${args.at} 处的值：${fmtNum(val)}`;
        }
        return `${order} 阶导数 d^${order}/d${variable}^${order} [${expr}] = ${text}${extra}`;
      }
      case 'integrate': {
        if (args.lower !== undefined && args.upper !== undefined) {
          const {f} = CALC.compile(expr, {});
          const val = CALC.integrateNumeric(v => f({[variable]: v}), Number(args.lower), Number(args.upper));
          let anti = '';
          const sym = CALC.integrateSymbolic(expr, variable);
          if (sym) anti = `\n（原函数：${toExpr(sym)}）`;
          return `∫ 从 ${args.lower} 到 ${args.upper} [${expr}] d${variable} = ${fmtNum(val)}${anti}`;
        }
        const sym = CALC.integrateSymbolic(expr, variable);
        if (!sym) return `无法求出 ${expr} 的符号原函数（本工具只支持多项式/基本初等函数及其线性复合）。请给 lower/upper 用数值定积分。`;
        return `∫ [${expr}] d${variable} = ${toExpr(sym)} + C`;
      }
      case 'limit': {
        const r = CALC.limit(expr, variable, Number(args.point ?? 0), args.dir || 'both');
        const v = !Number.isFinite(r.value) ? (r.value > 0 ? '+∞' : '-∞') : fmtNum(r.value);
        const parts = [`lim(${variable}→${args.point ?? 0}) ${expr} = ${v}`];
        if (args.dir === 'both' || !args.dir) parts.push(`左极限=${fmtNum(r.left)}  右极限=${fmtNum(r.right)}  直接代入=${r.at === null ? '无定义' : fmtNum(r.at)}`);
        if (r.converges === false) parts.push('⚠ 左右极限不一致，极限不存在');
        return parts.join('\n');
      }
      case 'solve': case 'roots': {
        const roots = CALC.findRoots(expr, variable, {lo: args.lo ?? -50, hi: args.hi ?? 50});
        if (!roots.length) return `在 [${args.lo ?? -50}, ${args.hi ?? 50}] 内没找到实根（若有虚根请用 calc 的 solve 或自行分析）`;
        const check = roots.map(r => {
          const {f} = CALC.compile(expr.includes('=') ? expr.split('=')[0] + '-(' + expr.split('=')[1] + ')' : expr, {});
          try { return f({[variable]: r}); } catch { return NaN; }
        });
        return `实根（${roots.length} 个）：${roots.map(fmtNum).join(', ')}\n代入残差：${check.map(c => fmtNum(Math.abs(c))).join(', ')}`;
      }
      case 'taylor': {
        const r = CALC.taylor(expr, variable, {at: Number(args.at ?? 0), order: Math.max(1, Math.min(12, Number(args.order) || 5))});
        const terms = r.terms.filter(t => Math.abs(t.coefficient) > 1e-14)
          .map(t => `${fmtNum(t.coefficient)}·(${variable}${r.at ? `-${r.at}` : ''})^${t.n}`);
        return `在 ${variable}=${r.at} 处的 ${r.order} 阶 Taylor 展开：\n${terms.join('  +  ') || '0'}\n各项系数：${r.terms.map(t => `n=${t.n}: ${fmtNum(t.coefficient)}`).join('  ')}`;
      }
      case 'sum': {
        const from = Number(args.from ?? 1), to = Number(args.to ?? 10);
        const r = CALC.seriesSum(expr, variable, from, to);
        return `Σ(${variable}=${from}..${to}) [${expr}] = ${fmtNum(r.sum)}\n共 ${r.terms} 项，末项 ${fmtNum(r.last)}${r.converging ? '' : '（末项未明显下降，可能发散）'}`;
      }
      case 'simplify': {
        const s = CALC.simplify(parse(expr));
        return `${expr}  →  ${toExpr(s)}`;
      }
      case 'eval': {
        const v = CALC.evaluateAt(expr, variable, Number(args.point ?? 0));
        return `${expr} 在 ${variable}=${args.point ?? 0} 处 = ${fmtNum(v)}`;
      }
      default:
        return `未知 op "${op}"。可用：derivative integrate limit solve taylor sum simplify eval`;
    }
  } catch (e) {
    return `calculus 执行失败：${e.message}`;
  }
}

// ================================================================ stats
export function statsTool(args = {}) {
  const {op} = args;
  try {
    switch (op) {
      case 'describe': {
        const d = ST.describe(args.data);
        return Object.entries(d).map(([k, v]) => `${k.padEnd(22)} ${typeof v === 'number' ? fmtNum(v) : fmt(v)}`).join('\n');
      }
      case 'dist': {
        const P = args.params || {};
        const x = Number(args.x0 ?? args.x ?? 0);
        const kind = args.kind || 'pdf';
        const name = String(args.dist || '').toLowerCase();
        let val;
        const pick = (pdf, cdf, inv) => (kind === 'cdf' ? cdf() : kind === 'quantile' ? inv() : pdf());
        if (name === 'normal' || name === 'norm') {
          const mu = Number(P.mu ?? 0), sd = Number(P.sigma ?? P.sd ?? 1);
          val = pick(() => SP.normPdf(x, mu, sd), () => SP.normCdf(x, mu, sd), () => SP.normInv(x, mu, sd));
        } else if (name === 't') {
          const df = Number(P.df);
          val = pick(() => SP.tPdf(x, df), () => SP.tCdf(x, df), () => SP.tInv(x, df));
        } else if (name === 'chi2' || name === 'chisq') {
          const df = Number(P.df);
          val = pick(() => SP.chi2Pdf(x, df), () => SP.chi2Cdf(x, df), () => SP.chi2Inv(x, df));
        } else if (name === 'f') {
          const d1 = Number(P.df1 ?? P.d1), d2 = Number(P.df2 ?? P.d2);
          val = pick(() => SP.fPdf(x, d1, d2), () => SP.fCdf(x, d1, d2), () => SP.fInv(x, d1, d2));
        } else if (name === 'binom' || name === 'binomial') {
          const n = Number(P.n), p = Number(P.p);
          val = kind === 'cdf' ? SP.binomCdf(x, n, p) : SP.binomPmf(x, n, p);
        } else if (name === 'poisson') {
          const lam = Number(P.lambda ?? P.lam);
          val = kind === 'cdf' ? SP.poissonCdf(x, lam) : SP.poissonPmf(x, lam);
        } else if (name === 'exp' || name === 'exponential') {
          const lam = Number(P.lambda ?? P.lam);
          val = kind === 'cdf' ? SP.expCdf(x, lam) : SP.expPdf(x, lam);
        } else return `未知分布 "${args.dist}"。支持：normal t chi2 f binom poisson exp`;
        return `${args.dist} ${kind}${kind === 'quantile' ? `(p=${x})` : `(x=${x})`} 参数 ${JSON.stringify(P)} = ${fmtNum(val)}`;
      }
      case 'ttest': {
        if (args.a && args.b) {
          const r = args.paired ? ST.ttestPaired(args.a, args.b) : ST.ttestTwo(args.a, args.b, {equalVar: !!args.equalVar, tail: args.tail || 'two'});
          return `配对/双样本 t 检验（${r.method || 'paired'}）：\nt = ${fmtNum(r.t)}, df = ${fmtNum(r.df)}, p = ${fmtNum(r.p)}\n组1 均值/标准差 = ${fmtNum(r.mean1 ?? r.mean)}, ${fmtNum(r.sd1 ?? r.sd)}\n组2 均值/标准差 = ${fmtNum(r.mean2)}, ${fmtNum(r.sd2)}`;
        }
        const r = ST.ttestOne(args.data, Number(args.mu ?? 0), args.tail || 'two');
        return `单样本 t 检验（H0: μ = ${args.mu ?? 0}）：\nn = ${r.n}, 均值 = ${fmtNum(r.mean)}, 标准差 = ${fmtNum(r.sd)}, 标准误 = ${fmtNum(r.se)}\nt = ${fmtNum(r.t)}, df = ${r.df}, p(${args.tail || 'two'}) = ${fmtNum(r.p)}\n95% 置信区间 = [${fmtNum(r.ci95[0])}, ${fmtNum(r.ci95[1])}]`;
      }
      case 'ztest': {
        const r = ST.ztest(args.data, Number(args.mu ?? 0), args.sigma === undefined ? null : Number(args.sigma), args.tail || 'two');
        return `z 检验：n = ${r.n}, 均值 = ${fmtNum(r.mean)}, σ = ${fmtNum(r.sigma)}\nz = ${fmtNum(r.z)}, p = ${fmtNum(r.p)}`;
      }
      case 'chisq': {
        if (args.table) {
          const r = ST.chi2Independence(args.table);
          return `卡方独立性检验：χ² = ${fmtNum(r.chi2)}, df = ${r.df}, p = ${fmtNum(r.p)}\n期望频数表：\n${fmt(r.expected, 0)}`;
        }
        const r = ST.chi2Gof(args.observed, args.expected);
        return `卡方拟合优度检验：χ² = ${fmtNum(r.chi2)}, df = ${r.df}, p = ${fmtNum(r.p)}\n期望频数：${fmt(r.expected)}`;
      }
      case 'anova': {
        const r = ST.anovaOneWay(args.groups);
        return `单因素方差分析：F(${r.df_between}, ${r.df_within}) = ${fmtNum(r.F)}, p = ${fmtNum(r.p)}\nSS组间 = ${fmtNum(r.ss_between)}, SS组内 = ${fmtNum(r.ss_within)}`;
      }
      case 'regress': {
        const r = ST.linreg(args.x, args.y);
        return `一元线性回归 y = a + b·x：\na(截距) = ${fmtNum(r.intercept)}\nb(斜率) = ${fmtNum(r.slope)}\nr = ${fmtNum(r.r)}, R² = ${fmtNum(r.r2)}\n斜率标准误 = ${fmtNum(r.se_slope)}, t = ${fmtNum(r.t)}, df = ${r.df}, p = ${fmtNum(r.p)}`;
      }
      case 'corr': {
        const r = args.method === 'spearman' ? ST.spearman(args.x, args.y) : ST.pearson(args.x, args.y);
        return `${args.method === 'spearman' ? 'Spearman' : 'Pearson'} 相关系数 = ${fmtNum(r)}`;
      }
      case 'comb': return `C(${args.n}, ${args.k}) = ${fmtNum(ST.comb(Number(args.n), Number(args.k)))}`;
      case 'perm': return `P(${args.n}, ${args.k}) = ${fmtNum(ST.perm(Number(args.n), Number(args.k)))}`;
      case 'bayes': {
        const r = ST.bayes(args.priors, args.likelihoods);
        return `后验概率 = ${fmt(r.posterior)}\n证据(归一化常数) = ${fmtNum(r.evidence)}`;
      }
      default:
        return `未知 op "${op}"。可用：describe dist ttest ztest chisq anova regress corr comb perm bayes`;
    }
  } catch (e) {
    return `stats 执行失败：${e.message}`;
  }
}

// ================================================================ 联网
async function fetchText(url, {timeout = TIMEOUT, headers = {}} = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: {'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers},
    });
    return {status: r.status, url: r.url, text: await r.text()};
  } finally { clearTimeout(t); }
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
export function stripTags(html) {
  // ★ 逐行 trim + 丢掉空行。原来的写法只把 `[ \t\u00a0]+` 压成单空格，
  //   于是 "<div></div><div></div>" 变成 "\n \n \n" —— \n{3,} 匹配不到（中间夹着空格），
  //   实测真实网页正文里 18%~24% 是这种纯空白，白吃掉 web_result_chars 的截断窗口，
  //   把本来够用的答案挤到窗口外（gushiwen 的《序志》就在 1285 > 1200 的位置）。
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n').map(s => s.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean).join('\n').trim();
}
function unwrapBingUrl(href) {
  try {
    const u = new URL(href, 'https://cn.bing.com');
    const raw = u.searchParams.get('u');
    if (raw && raw.startsWith('a1')) return Buffer.from(raw.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return href;
  } catch { return href; }
}
async function bingSearch(query, limit) {
  const {status, text} = await fetchText('https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN');
  if (status !== 200) throw new Error('bing HTTP ' + status);
  const out = [];
  for (const b of text.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || []) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    out.push({title: stripTags(a[2]), url: unwrapBingUrl(decodeEntities(a[1])), snippet: stripTags((b.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '')});
    if (out.length >= limit) break;
  }
  return out;
}
async function ddgSearch(query, limit) {
  const {text} = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query));
  const out = [];
  for (const b of text.match(/<a[^>]*class="result__a"[^>]*>[\s\S]*?<\/a>[\s\S]*?(?=<a[^>]*class="result__a"|$)/g) || []) {
    const a = b.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let url = decodeEntities(a[1]);
    const m = url.match(/[?&]uddg=([^&]+)/);
    if (m) url = decodeURIComponent(m[1]);
    out.push({title: stripTags(a[2]), url, snippet: stripTags((b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '')});
    if (out.length >= limit) break;
  }
  return out;
}

/** 搜狗：中文长尾查询表现最稳，摘要里常直接含有答案；链接是 /link?url= 跳转，抓不了，标出来别浪费调用 */
async function sogouSearch(query, limit) {
  const {status, text} = await fetchText('https://www.sogou.com/web?query=' + encodeURIComponent(query));
  if (status !== 200) throw new Error('sogou HTTP ' + status);
  const out = [];
  for (const b of text.match(/<div class="vrwrap[\s\S]*?(?=<div class="vrwrap|<\/body>)/g) || []) {
    const h = b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!h) continue;
    const title = stripTags(h[1]);
    if (!title) continue;
    const rel = (b.match(/href="(\/link\?url=[^"]+)"/) || [])[1];
    const abs = rel ? 'https://www.sogou.com' + decodeEntities(rel) : '';
    const body = stripTags(b);
    out.push({title, url: abs, redirect: !!rel, snippet: body.slice(title.length).trim()});
    if (out.length >= limit) break;
  }
  return out;
}

/** 360：同样以中文长尾为主，摘要质量高；链接是 so.com/link?m= 跳转（JS 跳转，抓不了） */
async function so360Search(query, limit) {
  const {status, text} = await fetchText('https://www.so.com/s?q=' + encodeURIComponent(query));
  if (status !== 200) throw new Error('so360 HTTP ' + status);
  const out = [];
  for (const b of text.match(/<li class="res-list[\s\S]*?<\/li>/g) || []) {
    const h = b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!h) continue;                                   // 首个块是内联 CSS，没有 h3
    const title = stripTags(h[1]);
    if (!title) continue;
    const href = (b.match(/href="(https?:\/\/[^"]+)"/) || [])[1] || '';
    const url = decodeEntities(href);
    const body = stripTags(b);
    out.push({title, url, redirect: /\/link\?m=/.test(url) || /ai\.so\.com\/search/.test(url), snippet: body.slice(title.length).trim()});
    if (out.length >= limit) break;
  }
  return out;
}

/** 查询切成实词（去掉标点，≥2 字）。"《春秋》" → "春秋"，否则书名号会把明明命中的结果判成不相关 */
function queryTerms(query) {
  return String(query || '')
    .replace(/[《》〈〉“”"'‘’（）()【】\[\]{}]/g, ' ')
    .split(/[\s,，、。？?！!：:；;|/\\]+/)
    .map(s => s.trim()).filter(s => s.length >= 2);
}

/**
 * 相关性打分（0 = 完全跑题）。为什么不是"有结果就用"、"过了闸门就用"：
 * 实测 Bing 对多词查询会退化成"查询第一个字的字典页"，
 *   「大历十才子 五言长城 刘长卿」→ 5 条全是「大」（汉语文字）_百度百科
 *   「司马迁 史记 体例 纪传体」  → 全是「司马」（中国古代官名）
 * 而单词查询正常（「大历十才子」→ 正确）。换分隔符（%20 / +）、换 host（cn/www）、
 * 去 setlang、换 Accept-Language 都无效 —— 是端点行为，不是我们能"修"的解析 bug。
 *
 * 也不能只看"有没有任一词命中"：查「量子纠缠 是什么 通俗解释」时，Bing 那份整体跑题的
 * 结果里第 4 条摘要偶然出现了"量子纠缠"，就足以让它过关（实测）。
 * 所以按命中词数打分、标题命中加权，最后**选分最高的后端**，而不是"第一个通过的就用"。
 */
export function relevanceScore(query, list) {
  if (!list || !list.length) return 0;
  const terms = queryTerms(query);
  if (!terms.length) return 1;
  const text = list.map(r => `${r.title || ''} ${r.snippet || ''}`).join(' ').replace(/\s+/g, '');
  const titles = list.map(r => String(r.title || '').replace(/\s+/g, '')).join(' ');
  let score = 0;
  for (const t of terms) {
    if (text.includes(t)) score += 1;
    if (titles.includes(t)) score += 0.5;   // 标题命中比摘要命中更能说明"这条就是讲这个的"
  }
  return score;
}

/** 保留布尔语义的薄封装（自检用） */
export function relevantEnough(query, list) {
  return relevanceScore(query, list) > 0;
}

/** 搜索结果摘要里的噪声：搜狗/360 会把来源站域名、广告和"推荐您搜索"之类塞进摘要 */
const SNIPPET_CUT = /(推荐您搜索|相关搜索|查看更多|展开全部|下载APP|备案号|看看.*怎么说|去试试|在线举报|下载元宝|更多知乎|广告)/;
function cleanSnippet(s) {
  const raw = String(s || '')
    .replace(/\S*:\/\/\S*/g, ' ');        // 摘要里夹的 https://www.sohu.com/a... 是**截断网址**，抓必然 502/404
  const m = raw.search(SNIPPET_CUT);      // 广告/相关搜索通常出现在中间，从那里截断
  return (m > 20 ? raw.slice(0, m) : raw).replace(/\s+/g, ' ').trim();
}

/** 结果条数尽量少而密：搜索摘要会在**后续每一轮**被重发，而 web_result_chars 会截断整个列表 */
function formatResults(engine, query, list, snippetChars = 200) {
  return [`搜索引擎：${engine} / 查询：${query}`,
    ...list.map((r, i) => {
      const url = r.url ? (r.redirect ? '（跳转链接，web_fetch 抓不到，别浪费调用）' : r.url) : '';
      const sn = cleanSnippet(r.snippet).slice(0, snippetChars);
      return `${i + 1}. ${r.title}${url ? '\n   ' + url : ''}${sn ? '\n   ' + sn : ''}`;
    })].join('\n');
}

export async function webSearch({query, max_results = 5} = {}) {
  if (!query) return '错误：query 不能为空';
  const limit = Math.max(1, Math.min(10, Number(max_results) || 5));
  const errors = [];
  let best = null;   // {name, list, score} 分数最高的那份
  let weak = null;   // 一份都没过闸门时的兜底（明确标注不可采信）
  // 顺序：Bing 有真实直链（能继续 web_fetch）；搜狗/360 中文长尾更稳但只有跳转链接
  for (const [name, fn] of [['bing', bingSearch], ['sogou', sogouSearch], ['so360', so360Search], ['duckduckgo', ddgSearch]]) {
    let list;
    try { list = await fn(query, limit); } catch (e) { errors.push(name + ': ' + e.message); continue; }
    if (!list.length) { errors.push(name + ': 0 结果'); continue; }
    const score = relevanceScore(query, list);
    if (!weak) weak = {name, list};
    if (!best || score > best.score) best = {name, list, score};
    if (score >= 3) break;   // 够强就不再打后面的后端，省时间（搜索本身很少用，但别白白多等几秒）
  }
  if (best && best.score > 0) return formatResults(best.name, query, best.list);
  if (weak) {
    return `⚠ 没找到真正相关的搜索结果（${errors.join(' | ')}）。\n`
      + '下面这份结果与查询的相关性未通过检查，**不要采信，也不要据此作答**；\n'
      + '请基于已有知识作答，或换一组更短的关键词重试一次。\n'
      + formatResults('（未通过相关性检查）', query, weak.list);
  }
  return `搜索失败（${errors.join(' | ')}）。可以改用 web_fetch 直接打开已知网址。`;
}
/** 反爬拦截页的特征（百度系对非浏览器请求一律 403 + 这个页面，实测换 UA/Referer/移动版 UA 都无效） */
const WALL_RE = /(安全验证|访问过于频繁|请输入验证码|滑动验证|人机验证|验证码|Just a moment|Attention Required|Enable JavaScript|请开启JavaScript|Forbidden|Access Denied)/i;

/** 判断这次抓取是不是撞上了反爬墙（抽出来是为了能在 --selftest 里离线验证） */
export function looksBlocked(status, title, body) {
  return status === 403 || status === 429 || WALL_RE.test(String(title || ''))
    || (String(body || '').length < 120 && WALL_RE.test(String(body || '')));
}

export async function webFetch({url, max_chars = 6000} = {}) {
  if (!/^https?:\/\//i.test(url || '')) return '错误：url 必须是完整 http/https 链接';
  try {
    const {status, url: finalUrl, text} = await fetchText(url);
    const title = stripTags((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const body = stripTags(text);
    // ★ 拦截页必须**报错而不是当正文返回**：原来 403 时会把"百度安全验证"这 6 个字
    //   当作网页正文交给模型，模型看不出这是失败，往往会拿它当"没查到"的证据继续推理。
    if (looksBlocked(status, title, body)) {
      return `抓取失败：${finalUrl} 被反爬拦截（HTTP ${status}${title ? ' / ' + title : ''}）。`
        + '该站点不接受程序化抓取，请改用搜索结果摘要，或换别的来源（维基/古诗文网/知网以外的公开站）。不要重试同一个 URL。';
    }
    const cap = Math.max(500, Math.min(30000, Number(max_chars) || 6000));
    return [`URL：${finalUrl}`, `HTTP：${status}`, `标题：${title}`, '—— 正文 ——',
      body.slice(0, cap) + (body.length > cap ? `\n…（截断，正文共 ${body.length} 字符）` : '')].join('\n');
  } catch (e) { return '抓取失败：' + e.message; }
}

// ================================================================ 分发
export async function runTool(name, args) {
  const started = Date.now();
  let result;
  try {
    if (name === 'web_search') result = await webSearch(args || {});
    else if (name === 'web_fetch') result = await webFetch(args || {});
    else if (name === 'calc') result = calc(args || {});
    else if (name === 'matrix') result = matrixTool(args || {});
    else if (name === 'calculus') result = calculusTool(args || {});
    else if (name === 'stats') result = statsTool(args || {});
    else result = '未知工具：' + name;
  } catch (e) {
    result = '工具执行异常：' + (e && e.message ? e.message : String(e));
  }
  return {result: String(result), ms: Date.now() - started};
}

export {L, ST, SP, CALC, FUNCTION_NAMES, parse, evaluate, createContext};
