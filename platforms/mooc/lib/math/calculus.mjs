/**
 * 微积分：符号求导、符号积分（基础规则）、数值定积分、极限、求根、Taylor 展开、级数求和
 * 全部基于 parser.mjs 的 AST，不依赖任何外部 CAS。
 */
import {parse, evaluate, createContext, toExpr} from './parser.mjs';
import {makeFunctions} from './functions.mjs';

const FUNCS = makeFunctions();
const NEWTON_STEPS = 60;

export function compile(expr, extraVars = {}) {
  const ast = parse(expr);
  const base = {...extraVars};
  return {
    ast,
    text: toExpr(ast),
    f: (v = {}) => evaluate(ast, createContext({vars: {...base, ...v}, funcs: FUNCS})),
  };
}

// ---------------------------------------------------------------- 化简
export function simplify(n) {
  if (!n || typeof n !== 'object') return n;
  const num = v => ({type: 'num', v});
  const isNum = (x, v) => x && x.type === 'num' && (v === undefined || Math.abs(x.v - v) < 1e-15);
  switch (n.type) {
    case 'bin': {
      let l = simplify(n.l), r = simplify(n.r);
      const op = n.op;
      if (op === '+' || op === '-') {
        if (isNum(r, 0)) return l;
        if (isNum(l, 0)) return op === '-' ? {type: 'un', op: '-', a: r} : r;
        if (l.type === 'num' && r.type === 'num') return num(op === '+' ? l.v + r.v : l.v - r.v);
        if (op === '-' && r.type === 'un' && r.op === '-') return simplify({type: 'bin', op: '+', l, r: r.a});
        return {type: 'bin', op, l, r};
      }
      if (op === '*') {
        if (isNum(l, 0) || isNum(r, 0)) return num(0);
        if (isNum(l, 1)) return r;
        if (isNum(r, 1)) return l;
        if (isNum(l, -1)) return simplify({type: 'un', op: '-', a: r});
        if (l.type === 'num' && r.type === 'num') return num(l.v * r.v);
        // 常数前移：x*2 → 2*x
        if (l.type !== 'num' && r.type === 'num') return {type: 'bin', op, l: r, r: l};
        return {type: 'bin', op, l, r};
      }
      if (op === '/') {
        if (isNum(r, 1)) return l;
        if (isNum(l, 0)) return num(0);
        if (l.type === 'num' && r.type === 'num' && r.v !== 0) {
          const q = l.v / r.v;
          if (Math.abs(q - Math.round(q)) < 1e-12 || Math.abs(q) < 1e12) return num(Number(q.toFixed(12)));
        }
        return {type: 'bin', op, l, r};
      }
      if (op === '^') {
        if (isNum(r, 1)) return l;
        if (isNum(r, 0)) return num(1);
        if (isNum(l, 1)) return num(1);
        if (isNum(l, 0)) return num(0);
        return {type: 'bin', op, l, r};
      }
      return {type: 'bin', op, l, r};
    }
    case 'un':
      if (n.op === '-') {
        const a = simplify(n.a);
        if (a.type === 'num') return num(-a.v);
        if (a.type === 'un' && a.op === '-') return a.a;
        return {type: 'un', op: '-', a};
      }
      return n;
    case 'call': return {type: 'call', name: n.name, args: n.args.map(simplify)};
    default: return n;
  }
}

// ---------------------------------------------------------------- 符号求导
const DERIV_TABLE = {
  sin: () => 'cos(x)',
  cos: () => '-sin(x)',
  tan: () => '1/cos(x)^2',
  asin: () => '1/sqrt(1-x^2)',
  acos: () => '-1/sqrt(1-x^2)',
  atan: () => '1/(1+x^2)',
  sinh: () => 'cosh(x)',
  cosh: () => 'sinh(x)',
  tanh: () => '1/cosh(x)^2',
  exp: () => 'exp(x)',
  ln: () => '1/x',
  log: () => '1/x',
  log10: () => '1/(x*ln(10))',
  log2: () => '1/(x*ln(2))',
  sqrt: () => '1/(2*sqrt(x))',
  cbrt: () => '1/(3*cbrt(x)^2)',
  abs: () => 'sign(x)',
  erf: () => '2/sqrt(pi)*exp(-x^2)',
  gamma: () => 'gamma(x)*digamma(x)',   // digamma 未实现，仅占位（会在报错时提示）
};

function d(node, v) {
  const num = k => ({type: 'num', v: k});
  const bin = (op, l, r) => ({type: 'bin', op, l, r});
  const call = (name, ...args) => ({type: 'call', name, args});
  switch (node.type) {
    case 'num': return num(0);
    case 'var': return num(node.name === v ? 1 : 0);
    case 'array': throw new Error('求导不支持数组');
    case 'un':
      if (node.op === '-') return {type: 'un', op: '-', a: d(node.a, v)};
      return num(0);
    case 'bin': {
      const {op, l, r} = node;
      if (op === '+' || op === '-') return bin(op, d(l, v), d(r, v));
      if (op === '*') return bin('+', bin('*', d(l, v), r), bin('*', l, d(r, v)));
      if (op === '/') return bin('/', bin('-', bin('*', d(l, v), r), bin('*', l, d(r, v))), bin('^', r, num(2)));
      if (op === '^') {
        const rConst = !containsVar(r, v);
        const lConst = !containsVar(l, v);
        if (rConst) return bin('*', bin('*', r, bin('^', l, bin('-', r, num(1)))), d(l, v));     // n·u^(n-1)·u'
        if (lConst) return bin('*', bin('*', bin('^', l, r), call('ln', l)), d(r, v));            // a^v·ln a·v'
        // u^v = e^(v ln u)
        return bin('*', bin('^', l, r), bin('+', bin('*', d(r, v), call('ln', l)), bin('/', bin('*', r, d(l, v)), l)));
      }
      throw new Error('未支持的运算符求导：' + op);
    }
    case 'call': {
      const {name, args} = node;
      if (args.length !== 1) throw new Error(`只支持一元函数的求导：${name}`);
      const u = args[0];
      const inner = d(u, v);
      const outer = substituteStr(DERIV_TABLE[name] ? DERIV_TABLE[name]() : null, u, v, name);
      return bin('*', outer, inner);
    }
    default: throw new Error('无法求导的节点：' + node.type);
  }
}

function containsVar(n, v) {
  if (!n || typeof n !== 'object') return false;
  if (n.type === 'var') return n.name === v;
  if (n.type === 'num') return false;
  if (n.type === 'un') return containsVar(n.a, v);
  if (n.type === 'bin') return containsVar(n.l, v) || containsVar(n.r, v);
  if (n.type === 'call') return n.args.some(a => containsVar(a, v));
  return false;
}

/** 把导函数模板里的 x 换成实际内层表达式 u */
function substituteStr(tpl, u, v, name) {
  if (tpl === null) throw new Error(`暂不支持对 ${name}() 求导`);
  const ast = parse(tpl);
  const rep = n => {
    if (n.type === 'var' && n.name === 'x') return u;
    if (n.type === 'un') return {type: 'un', op: n.op, a: rep(n.a)};
    if (n.type === 'bin') return {type: 'bin', op: n.op, l: rep(n.l), r: rep(n.r)};
    if (n.type === 'call') return {type: 'call', name: n.name, args: n.args.map(rep)};
    return n;
  };
  return rep(ast);
}

/** 求 n 阶导数（符号） */
export function derivative(expr, variable = 'x', order = 1) {
  let ast = parse(expr);
  for (let i = 0; i < order; i++) ast = simplify(d(ast, variable));
  return ast;
}

// ---------------------------------------------------------------- 符号积分（基础规则）
function freeOf(n, v) { return !containsVar(n, v); }

/** 返回不定积分 AST，或 null（表示不会做） */
function integrateNode(n, v) {
  const num = k => ({type: 'num', v: k});
  const bin = (op, l, r) => ({type: 'bin', op, l, r});
  const V = {type: 'var', name: v};
  if (freeOf(n, v)) return bin('*', n, V);                                   // ∫c dx = cx
  if (n.type === 'var' && n.name === v) return bin('/', bin('^', V, num(2)), num(2));  // ∫x dx
  if (n.type === 'un' && n.op === '-') { const r = integrateNode(n.a, v); return r && {type: 'un', op: '-', a: r}; }
  if (n.type === 'bin') {
    if (n.op === '+') { const a = integrateNode(n.l, v), b = integrateNode(n.r, v); return a && b ? bin('+', a, b) : null; }
    if (n.op === '-') { const a = integrateNode(n.l, v), b = integrateNode(n.r, v); return a && b ? bin('-', a, b) : null; }
    if (n.op === '*') {
      if (freeOf(n.l, v)) { const r = integrateNode(n.r, v); return r && bin('*', n.l, r); }
      if (freeOf(n.r, v)) { const r = integrateNode(n.l, v); return r && bin('*', r, n.r); }
      return null;
    }
    if (n.op === '/' && freeOf(n.r, v)) { const r = integrateNode(bin('*', bin('/', num(1), n.r), n.l), v); return r; }
    if (n.op === '^') {
      // x^n
      if (n.l.type === 'var' && n.l.name === v && freeOf(n.r, v)) {
        if (Math.abs(n.r.v + 1) < 1e-12) return {type: 'call', name: 'ln', args: [{type: 'call', name: 'abs', args: [V]}]};
        return bin('/', bin('^', V, bin('+', n.r, num(1))), bin('+', n.r, num(1)));
      }
      // e^(ax+b)
      if (n.l.type === 'var' && n.l.name === 'e') {
        const inner = n.r;
        if (linearCoef(inner, v) !== null) return bin('/', n, num(linearCoef(inner, v)));
      }
      return null;
    }
  }
  if (n.type === 'call' && n.args.length === 1) {
    const u = n.args[0];
    const k = linearCoef(u, v);      // 只处理 u = k·x + b 的情形
    if (k === null || k === 0) return null;
    const X = u;
    const table = {
      sin: {type: 'un', op: '-', a: {type: 'call', name: 'cos', args: [X]}},
      cos: {type: 'call', name: 'sin', args: [X]},
      exp: {type: 'call', name: 'exp', args: [X]},
      tan: {type: 'un', op: '-', a: {type: 'call', name: 'ln', args: [{type: 'call', name: 'abs', args: [{type: 'call', name: 'cos', args: [X]}]}]}},
      ln: {type: 'bin', op: '-', l: {type: 'bin', op: '*', l: X, r: {type: 'call', name: 'ln', args: [X]}}, r: X},
      sqrt: {type: 'bin', op: '*', l: {type: 'bin', op: '/', l: {type: 'num', v: 2}, r: {type: 'num', v: 3}}, r: {type: 'bin', op: '^', l: X, r: {type: 'bin', op: '/', l: {type: 'num', v: 3}, r: {type: 'num', v: 2}}}},
      sinh: {type: 'call', name: 'cosh', args: [X]},
      cosh: {type: 'call', name: 'sinh', args: [X]},
    };
    const base = table[n.name];
    if (base) return {type: 'bin', op: '/', l: base, r: {type: 'num', v: k}};
    return null;
  }
  return null;
}

/** 若表达式是 a·x + b（a≠0），返回 a；否则 null */
function linearCoef(node, v) {
  const lin = n => {
    if (!containsVar(n, v)) return {a: 0, b: evalConst(n)};
    if (n.type === 'var' && n.name === v) return {a: 1, b: 0};
    if (n.type === 'un' && n.op === '-') { const r = lin(n.a); return r && {a: -r.a, b: -r.b}; }
    if (n.type === 'bin' && (n.op === '+' || n.op === '-')) {
      const l = lin(n.l), r = lin(n.r);
      if (!l || !r) return null;
      return {a: n.op === '+' ? l.a + r.a : l.a - r.a, b: n.op === '+' ? l.b + r.b : l.b - r.b};
    }
    if (n.type === 'bin' && n.op === '*') {
      const lf = freeOf(n.l, v), rf = freeOf(n.r, v);
      if (lf && !rf) { const r = lin(n.r); return r && {a: evalConst(n.l) * r.a, b: evalConst(n.l) * r.b}; }
      if (rf && !lf) { const l = lin(n.l); return l && {a: evalConst(n.r) * l.a, b: evalConst(n.r) * l.b}; }
      return null;
    }
    if (n.type === 'bin' && n.op === '/' && freeOf(n.r, v)) {
      const l = lin(n.l);
      return l && {a: l.a / evalConst(n.r), b: l.b / evalConst(n.r)};
    }
    return null;
  };
  const r = lin(node);
  return r && Math.abs(r.a) > 1e-14 ? r.a : null;
}
function evalConst(n) { return evaluate(n, createContext({vars: {}, funcs: FUNCS})); }

export function integrateSymbolic(expr, variable = 'x') {
  const ast = parse(expr);
  const r = integrateNode(ast, variable);
  return r ? simplify(r) : null;
}

// ---------------------------------------------------------------- 数值积分
/** 自适应 Simpson */
export function integrateNumeric(f, a, b, tol = 1e-10, maxDepth = 50) {
  const simpson = (a, b, fa, fm, fb) => (b - a) / 6 * (fa + 4 * fm + fb);
  const rec = (a, b, fa, fm, fb, whole, depth) => {
    const m = (a + b) / 2;
    const lm = (a + m) / 2, rm = (m + b) / 2;
    const flm = f(lm), frm = f(rm);
    const left = simpson(a, m, fa, flm, fm);
    const right = simpson(m, b, fm, frm, fb);
    const delta = left + right - whole;
    if (depth <= 0 || Math.abs(delta) <= 15 * tol) return left + right + delta / 15;
    return rec(a, m, fa, flm, fm, left, depth - 1) + rec(m, b, fm, frm, fb, right, depth - 1);
  };
  const fa = f(a), fb = f(b), m = (a + b) / 2, fm = f(m);
  const whole = simpson(a, b, fa, fm, fb);
  let value = rec(a, b, fa, fm, fb, whole, maxDepth);
  // 端点奇点（如 ∫1/√x）：退化处理
  if (!Number.isFinite(value)) {
    const eps = (b - a) * 1e-8;
    value = rec(a + eps, b, f(a + eps), f((a + eps + b) / 2), fb, simpson(a + eps, b, f(a + eps), f((a + eps + b) / 2), fb), maxDepth);
  }
  return value;
}

// ---------------------------------------------------------------- 极限
export function limit(expr, variable = 'x', point = 0, dir = 'both') {
  const {f} = compile(expr, {});
  const at = v => { try { return f({[variable]: v}); } catch { return NaN; } };
  const estimate = (side, hs) => {
    const vals = hs.map(h => at(point + side * h));
    // Richardson 外推：L ≈ (4 L(h/2) − L(h)) / 3
    const good = vals.filter(Number.isFinite);
    if (!good.length) return {value: NaN, converged: false};
    if (good.length < 3) return {value: good[good.length - 1], converged: true};
    const r = [];
    for (let i = 0; i + 1 < good.length; i++) r.push((4 * good[i + 1] - good[i]) / 3);
    const last = r[r.length - 1];
    const prev = r[r.length - 2];
    return {value: last, converged: Math.abs(last - prev) < 1e-7 * Math.max(1, Math.abs(last))};
  };
  const HS_BASE = [1e-2, 5e-3, 2.5e-3, 1.25e-3, 6.25e-4, 3.125e-4];
  const trial = (side) => {
    let last = null;
    for (const scale of [1, 1e-1, 1e-2]) {
      const hs = HS_BASE.map(h => h * scale);
      // 发散检测：h 越接近 0，|f| 反而成倍增长（如 1/x 在 0 处）
      const raw = hs.map(h => { try { return f({[variable]: point + side * h}); } catch { return NaN; } }).filter(Number.isFinite);
      if (raw.length >= 3) {
        const a = Math.abs(raw[raw.length - 3]), b2 = Math.abs(raw[raw.length - 1]);
        if (b2 > 1e3 && b2 > a * 1.8) return {value: (raw[raw.length - 1] > 0 ? 1 : -1) * Infinity, side, diverging: true, converged: true};
      }
      const r = estimate(side, hs);
      if (!Number.isFinite(r.value)) continue;
      if (Math.abs(r.value) > 1e7) return {value: side > 0 ? Infinity : -Infinity, side, diverging: true};
      last = {...r, side};
      if (r.converged) return last;
    }
    return last;
  };
  const left = dir === '+' ? null : trial(-1);
  const right = dir === '-' ? null : trial(1);
  const direct = (() => { const v = at(point); return Number.isFinite(v) ? v : null; })();
  const pick = dir === '+' ? right : dir === '-' ? left : null;
  const sameSign = left && right && (left.diverging || right.diverging)
    ? (Math.sign(left.value) === Math.sign(right.value) ? left.diverging : false)
    : null;
  let value;
  if (pick) value = pick.value;
  else if (left && right && left.diverging && right.diverging && sameSign) value = left.value;
  else if (left && right && Math.abs(left.value - right.value) < 1e-6 * Math.max(1, Math.abs(left.value))) value = (left.value + right.value) / 2;
  else if (direct !== null) value = direct;
  else value = left ? left.value : right ? right.value : NaN;
  const converges = !(left && right) ? true : (left.diverging && right.diverging ? Math.sign(left.value) === Math.sign(right.value) : Math.abs(left.value - right.value) < 1e-6 * Math.max(1, Math.abs(left.value)));
  return {value, left: left && left.value, right: right && right.value, at: direct, converges, diverging: !!(left && left.diverging) || !!(right && right.diverging)};
}

// ---------------------------------------------------------------- 求根
export function findRoots(expr, variable = 'x', {lo = -50, hi = 50, samples = 4000, tol = 1e-12} = {}) {
  let ast;
  let f;
  if (expr.includes('=')) {
    const [lhs, rhs] = expr.split('=');
    ast = {type: 'bin', op: '-', l: parse(lhs), r: parse(rhs)};
    f = v => evaluate(ast, createContext({vars: {[variable]: v}, funcs: FUNCS}));
  } else {
    ast = parse(expr);
    f = v => evaluate(ast, createContext({vars: {[variable]: v}, funcs: FUNCS}));
  }
  const roots = [];
  const push = x => { if (!roots.some(r => Math.abs(r - x) < 1e-7)) roots.push(x); };
  const step = (hi - lo) / samples;
  let prevX = lo, prevF = f(lo);
  if (prevF === 0) push(lo);
  for (let i = 1; i <= samples; i++) {
    const x = lo + i * step;
    let fx = f(x);
    if (!Number.isFinite(fx)) {
      // 跨越奇点时取极限中点
      const mid = (prevX + x) / 2;
      const fm = f(mid);
      prevX = x; prevF = Number.isFinite(fm) ? fm : NaN;
      continue;
    }
    if (fx === 0 || (Number.isFinite(prevF) && prevF * fx < 0)) {
      // 二分 + 牛顿细化
      let a = prevX, b = x, fa = prevF, fb = fx;
      for (let k = 0; k < 200; k++) {
        const m = (a + b) / 2;
        const fm = f(m);
        if (!Number.isFinite(fm)) break;
        if (fm === 0 || (b - a) < tol * Math.max(1, Math.abs(m))) { a = m; b = m; break; }
        if (fa * fm < 0) { b = m; fb = fm; } else { a = m; fa = fm; }
      }
      let r = (a + b) / 2;
      const nr = newton(f, r);
      if (nr !== null && Math.abs(f(nr)) < Math.abs(f(r))) r = nr;
      push(Number(r.toFixed(12)));
    }
    prevX = x; prevF = fx;
  }
  return roots.sort((a, b) => a - b);
}
function newton(f, x0, steps = NEWTON_STEPS) {
  let x = x0;
  for (let i = 0; i < steps; i++) {
    const h = 1e-7 * Math.max(1, Math.abs(x));
    const f0 = f(x), f1 = f(x + h);
    const d = (f1 - f0) / h;
    if (!Number.isFinite(d) || Math.abs(d) < 1e-14) return null;
    const nx = x - f0 / d;
    if (!Number.isFinite(nx)) return null;
    if (Math.abs(nx - x) < 1e-15 * Math.max(1, Math.abs(nx))) return nx;
    x = nx;
  }
  return x;
}

// ---------------------------------------------------------------- Taylor
export function taylor(expr, variable = 'x', {at = 0, order = 5} = {}) {
  const {f} = compile(expr, {});
  const terms = [];
  let ast = parse(expr);
  for (let n = 0; n <= order; n++) {
    const val = evaluate(ast, createContext({vars: {[variable]: at}, funcs: FUNCS}));
    const coef = val / factorialJS(n);
    terms.push({n, coefficient: Number(coef.toFixed(12))});
    ast = simplify(d(ast, variable));
  }
  const poly = terms.map(({n, coefficient}) => ({term: `(${coefficient}) * (x-${at})^${n}`, coefficient, n}));
  return {at, order, terms, derivativeExpression: toExpr(ast), polynomial: poly.map(p => p.term).join(' + ')};
}
function factorialJS(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }

// ---------------------------------------------------------------- 级数求和
export function seriesSum(expr, variable = 'k', from = 1, to = 10) {
  const {f} = compile(expr, {});
  const fv = v => { try { return f({[variable]: v}); } catch { return NaN; } };
  const terms = [];
  let s = 0;
  for (let k = from; k <= to; k++) { const v = fv(k); if (Number.isFinite(v)) { s += v; terms.push(v); } }
  // 若末项还很大，提示可能不收敛
  const tail = terms.slice(-5);
  return {sum: s, terms: terms.length, last: terms[terms.length - 1], converging: tail.every((v, i) => i === 0 || Math.abs(v) <= Math.abs(tail[i - 1]) * 1.05)};
}

export function evaluateAt(expr, variable = 'x', point = 0) {
  const {f} = compile(expr, {});
  return f({[variable]: point});
}

export {toExpr, FUNCS};
