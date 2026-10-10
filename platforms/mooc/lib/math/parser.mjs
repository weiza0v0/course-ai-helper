/**
 * 安全数学表达式解析器（零依赖、无 eval / new Function）
 *
 * 支持：数字（含 1e5、π、inf）、变量、函数调用、+ - * / % ^（含 **）、
 *       一元正负、括号、向量 [1,2,3]、矩阵 [[1,2],[3,4]]、隐式乘法（2x、3(x+1)、2sin(x)）
 *
 * 之所以自己写解析器而不是 new Function：
 *   1) 彻底消除代码注入面（之前 process.exit(1) 真把测试进程退掉过）；
 *   2) 拿到 AST 之后，符号求导/积分/化简才有可能；
 *   3) 可以给任意点求值 f(x)，这是数值积分/求根/极限的基础。
 */

import {invert, matmul, dot, scale} from './linalg.mjs';

const CONSTS = {pi: Math.PI, 'π': Math.PI, e: Math.E, tau: 2 * Math.PI, inf: Infinity, infinity: Infinity, nan: NaN};

export function tokenize(src) {
  const s = String(src);
  const out = [];
  let i = 0;
  const isDigit = c => c >= '0' && c <= '9';
  const isIdStart = c => /[A-Za-z_\u0370-\u03ff\u4e00-\u9fa5]/.test(c);
  const isId = c => /[A-Za-z0-9_\u0370-\u03ff\u4e00-\u9fa5]/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u00a0') { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
      let j = i;
      while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
      if (s[j] === 'e' || s[j] === 'E') {
        let k = j + 1;
        if (s[k] === '+' || s[k] === '-') k++;
        if (isDigit(s[k])) { while (k < s.length && isDigit(s[k])) k++; j = k; }
      }
      out.push({t: 'num', v: parseFloat(s.slice(i, j))});
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < s.length && isId(s[j])) j++;
      out.push({t: 'id', v: s.slice(i, j)});
      i = j;
      continue;
    }
    if (c === '*' && s[i + 1] === '*') { out.push({t: 'op', v: '^'}); i += 2; continue; }
    if ('+-*/%^(),[]'.includes(c)) { out.push({t: 'op', v: c}); i++; continue; }
    if (c === '×' || c === '·' || c === '⋅') { out.push({t: 'op', v: '*'}); i++; continue; }
    if (c === '−' || c === '–') { out.push({t: 'op', v: '-'}); i++; continue; }
    if (c === '÷') { out.push({t: 'op', v: '/'}); i++; continue; }
    if (c === '{') { out.push({t: 'op', v: '['}); i++; continue; }
    if (c === '}') { out.push({t: 'op', v: ']'}); i++; continue; }
    throw new Error(`无法识别的字符 "${c}"（位置 ${i}）`);
  }
  return out;
}

export function parse(src) {
  const ts = tokenize(src);
  let p = 0;
  const peek = () => ts[p];
  const isOp = v => { const x = ts[p]; return x && x.t === 'op' && x.v === v; };
  const eat = v => { if (!isOp(v)) throw new Error(`表达式语法错误：缺少 "${v}"`); p++; };

  function expr() {
    let left = term();
    for (;;) {
      if (isOp('+') || isOp('-')) { const op = ts[p++].v; left = {type: 'bin', op, l: left, r: term()}; }
      else return left;
    }
  }
  function term() {
    let left = unary();
    for (;;) {
      if (isOp('*') || isOp('/') || isOp('%')) { const op = ts[p++].v; left = {type: 'bin', op, l: left, r: unary()}; }
      else if (isOp('^')) { p++; left = {type: 'bin', op: '^', l: left, r: unary()}; }
      else if (startsPrimary(peek())) { left = {type: 'bin', op: '*', l: left, r: unary(), implicit: true}; }  // 隐式乘法
      else return left;
    }
  }
  function startsPrimary(tk) {
    if (!tk) return false;
    if (tk.t === 'num') return true;
    if (tk.t === 'id') return true;
    return tk.t === 'op' && tk.v === '(';
  }
  function unary() {
    if (isOp('-')) { p++; return {type: 'un', op: '-', a: unary()}; }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    if (isOp('^')) { p++; return {type: 'bin', op: '^', l: base, r: unary()}; }
    return base;
  }
  function atom() {
    const tk = peek();
    if (!tk) throw new Error('表达式意外结束');
    if (tk.t === 'num') { p++; return {type: 'num', v: tk.v}; }
    if (tk.t === 'id') {
      p++;
      if (isOp('(')) {
        p++;
        const args = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) { p++; args.push(expr()); }
        }
        eat(')');
        return {type: 'call', name: tk.v, args};
      }
      return {type: 'var', name: tk.v};
    }
    if (tk.t === 'op' && tk.v === '(') {
      p++;
      const x = expr();
      eat(')');
      return x;
    }
    if (tk.t === 'op' && tk.v === '[') {
      p++;
      const items = [];
      if (!isOp(']')) {
        items.push(expr());
        while (isOp(',')) { p++; items.push(expr()); }
      }
      eat(']');
      return {type: 'array', items};
    }
    throw new Error('表达式语法错误：意外的记号 ' + JSON.stringify(tk));
  }

  const ast = expr();
  if (p < ts.length) throw new Error('表达式语法错误：多余的内容 ' + JSON.stringify(ts.slice(p, p + 3)));
  return ast;
}

// ---------------------------------------------------------------- 求值
export function createContext({vars = {}, funcs = {}, constants = {}} = {}) {
  return {vars: {...vars}, funcs, constants: {...CONSTS, ...constants}};
}

export function evaluate(ast, ctx) {
  switch (ast.type) {
    case 'num': return ast.v;
    case 'var': {
      if (ast.name in ctx.vars) return ctx.vars[ast.name];
      if (ast.name in ctx.constants) return ctx.constants[ast.name];
      const up = ast.name.toUpperCase();
      if (up === 'PI') return Math.PI;
      if (up === 'E') return Math.E;
      if (up in ctx.constants) return ctx.constants[up];
      throw new Error(`未知的符号 "${ast.name}"（可用变量请用 --var 传，常用常量有 pi、e）`);
    }
    case 'un': {
      const a = evaluate(ast.a, ctx);
      return ast.op === '-' ? neg(a) : a;
    }
    case 'bin': return binOp(ast.op, evaluate(ast.l, ctx), evaluate(ast.r, ctx));
    case 'call': {
      const fn = ctx.funcs[ast.name] || ctx.funcs[ast.name.toLowerCase()];
      if (!fn) throw new Error(`未知函数 "${ast.name}"（用 help 查看支持哪些函数）`);
      return fn(...ast.args.map(a => evaluate(a, ctx)));
    }
    case 'array': {
      const items = ast.items.map(a => evaluate(a, ctx));
      if (items.length && items.every(Array.isArray)) {
        const w = items[0].length;
        if (!items.every(r => r.length === w)) throw new Error('矩阵各行长度不一致');
        return items;
      }
      if (items.some(Array.isArray)) throw new Error('数组元素类型不一致');
      return items;
    }
    default: throw new Error('未知的 AST 节点：' + ast.type);
  }
}

function neg(v) {
  if (Array.isArray(v)) return v.map(neg);
  return -v;
}

export function isMatrix(v) { return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]); }
export function isVector(v) { return Array.isArray(v) && (v.length === 0 || !Array.isArray(v[0])); }

function binOp(op, a, b) {
  const Am = isMatrix(a), Bm = isMatrix(b), Av = isVector(a), Bv = isVector(b);
  switch (op) {
    case '+':
      if (Array.isArray(a) && Array.isArray(b)) return zipMap(a, b, (x, y) => x + y);
      if (Array.isArray(a)) return a.map(x => x + b);
      if (Array.isArray(b)) return b.map(x => a + x);
      return a + b;
    case '-':
      if (Array.isArray(a) && Array.isArray(b)) return zipMap(a, b, (x, y) => x - y);
      if (Array.isArray(a)) return a.map(x => x - b);
      if (Array.isArray(b)) return b.map(x => a - x);
      return a - b;
    case '*':
      if (typeof a === 'number' && Array.isArray(b)) return scale(b, a);
      if (typeof b === 'number' && Array.isArray(a)) return scale(a, b);
      if (Am && Bm) return matmul(a, b);
      if (Am && Bv) return matVec(a, b);
      if (Av && Bm) return vecMat(a, b);
      if (Av && Bv) return dot(a, b);
      return a * b;
    case '/':
      if (typeof b === 'number' && Array.isArray(a)) return scale(a, 1 / b);
      if (Am && Bm) return matmul(a, invert(b));
      return a / b;
    case '%': return a % b;
    case '^': {
      if (typeof a === 'number' && typeof b === 'number') return Math.pow(a, b);
      if (Array.isArray(a) && Number.isInteger(b)) return matpow(a, b);
      if (Array.isArray(a) && typeof b === 'number') return a.map(x => Math.pow(x, b));
      throw new Error('不支持的乘方组合');
    }
    default: throw new Error('未知运算符 ' + op);
  }
}

function zipMap(a, b, f) {
  if (a.length !== b.length) throw new Error(`长度不一致：${a.length} vs ${b.length}`);
  return a.map((x, i) => Array.isArray(x) ? zipMap(x, b[i], f) : f(x, b[i]));
}
function matVec(A, x) { return A.map(row => dot(row, x)); }
function vecMat(x, A) {
  const n = A[0].length;
  const out = new Array(n).fill(0);
  for (let j = 0; j < n; j++) for (let i = 0; i < x.length; i++) out[j] += x[i] * A[i][j];
  return out;
}
function matpow(A, k) {
  if (!Number.isInteger(k) || k < 0) throw new Error('矩阵幂只支持非负整数');
  const n = A.length;
  let R = Array.from({length: n}, (_, i) => Array.from({length: n}, (_, j) => (i === j ? 1 : 0)));
  for (let t = 0; t < k; t++) R = matmul(R, A);
  return R;
}

// ---------------------------------------------------------------- 转字符串
export function toExpr(ast, prec = 0) {
  const P = {'+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 4};
  switch (ast.type) {
    case 'num': return String(round(ast.v));
    case 'var': return ast.name;
    case 'array': return '[' + ast.items.map(x => toExpr(x, 0)).join(', ') + ']';
    case 'call': return `${ast.name}(${ast.args.map(a => toExpr(a, 0)).join(', ')})`;
    case 'un': return '-' + toExpr(ast.a, 3);
    case 'bin': {
      const op = ast.op;
      const my = P[op] ?? 0;
      const lt = toExpr(ast.l, op === '^' ? my : my - (op === '-' || op === '/' ? 1 : 0));
      const rt = toExpr(ast.r, my + (op === '^' ? 0 : 1));
      const s = `${lt} ${op} ${rt}`;
      return my < prec ? `(${s})` : s;
    }
    default: return '?';
  }
}
function round(x) {
  if (!Number.isFinite(x)) return x;
  if (Math.abs(x - Math.round(x)) < 1e-12) return Math.round(x);
  return x;
}
export {matmul, dot, scale, matpow, round};
export const constNames = Object.keys(CONSTS);
