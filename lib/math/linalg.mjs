/**
 * 线性代数：矩阵基本运算、行列式、逆、秩、RREF、线性方程组、LU/QR、特征值、范数
 * 全部零依赖、自包含（不 import parser，避免循环依赖）。
 */

export const isMatrix = v => Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
export const isVector = v => Array.isArray(v) && (v.length === 0 || !Array.isArray(v[0]));
export const shape = A => (isMatrix(A) ? [A.length, A[0].length] : isVector(A) ? [A.length] : []);
export const clone = A => A.map(r => (Array.isArray(r) ? r.slice() : r));
export const zeros = (n, m = n) => Array.from({length: n}, () => new Array(m).fill(0));
export const eye = n => Array.from({length: n}, (_, i) => Array.from({length: n}, (_, j) => (i === j ? 1 : 0)));
export const diag = v => (isMatrix(v) ? v.map((r, i) => r[i]) : Array.from({length: v.length}, (_, i) => Array.from({length: v.length}, (_, j) => (i === j ? v[i] : 0))));

export function transpose(A) {
  if (isVector(A)) return [A.slice()];
  const [n, m] = shape(A);
  return Array.from({length: m}, (_, j) => Array.from({length: n}, (_, i) => A[i][j]));
}
export function matmul(A, B) {
  if (isVector(A)) A = [A];
  if (isVector(B)) B = B.map(x => [x]);
  const [n, k] = shape(A), [k2, m] = shape(B);
  if (k !== k2) throw new Error(`矩阵维度不匹配：(${n}×${k}) × (${k2}×${m})`);
  const C = zeros(n, m);
  for (let i = 0; i < n; i++) for (let t = 0; t < k; t++) { const a = A[i][t]; if (!a) continue; for (let j = 0; j < m; j++) C[i][j] += a * B[t][j]; }
  return C;
}
export function add(A, B) { return A.map((r, i) => (Array.isArray(r) ? r.map((x, j) => x + B[i][j]) : r + B[i])); }
export function sub(A, B) { return A.map((r, i) => (Array.isArray(r) ? r.map((x, j) => x - B[i][j]) : r - B[i])); }
export function scale(A, k) { return A.map(r => (Array.isArray(r) ? r.map(x => x * k) : r * k)); }
export function trace(A) { let s = 0; for (let i = 0; i < A.length; i++) s += A[i][i]; return s; }
export function dot(u, v) {
  if (u.length !== v.length) throw new Error('向量长度不一致');
  return u.reduce((s, x, i) => s + x * v[i], 0);
}
export function cross(u, v) {
  if (u.length !== 3 || v.length !== 3) throw new Error('叉积只支持三维向量');
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
export function norm(A, type = 'fro') {
  if (type === 2 && isMatrix(A)) return Math.sqrt(maxEigenSymmetric(matmul(transpose(A), A)));   // 谱范数
  const flat = A.flat(Infinity).map(Math.abs);
  if (type === 1) return isMatrix(A) ? Math.max(...transpose(A).map(c => c.reduce((s, x) => s + Math.abs(x), 0))) : flat.reduce((s, x) => s + x, 0);
  if (type === 'inf') return isMatrix(A) ? Math.max(...A.map(r => r.reduce((s, x) => s + Math.abs(x), 0))) : Math.max(...flat);
  return Math.sqrt(flat.reduce((s, x) => s + x * x, 0));   // Frobenius / 向量 2-范数
}

/** 行列式：LU 部分主元 */
export function det(A) {
  if (!isMatrix(A)) throw new Error('det 需要方阵');
  const n = A.length;
  if (A.some(r => r.length !== n)) throw new Error('det 需要 n×n 方阵');
  const M = clone(A).map(r => r.map(Number));
  const tol = eps(M);
  let d = 1;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (Math.abs(M[p][i]) < tol) return 0;
    if (p !== i) { [M[i], M[p]] = [M[p], M[i]]; d = -d; }
    d *= M[i][i];
    for (let r = i + 1; r < n; r++) {
      const f = M[r][i] / M[i][i];
      if (!f) continue;
      for (let c = i; c < n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return snap(d);
}
function eps(A) {
  const m = Math.max(...A.flat(Infinity).map(Math.abs), 1);
  return m * 1e-12;
}
function snap(x) {
  if (!Number.isFinite(x)) return x;
  const r = Math.round(x);
  if (Math.abs(x - r) < 1e-10 * Math.max(1, Math.abs(x))) return r;
  return Number(x.toFixed(12));
}

/** 逆矩阵：Gauss-Jordan */
export function invert(A) {
  if (!isMatrix(A)) throw new Error('inv 需要方阵');
  const n = A.length;
  if (A.some(r => r.length !== n)) throw new Error('inv 需要 n×n 方阵');
  const M = clone(A).map(r => r.map(Number));
  const I = eye(n);
  const tol = eps(M);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (Math.abs(M[p][i]) < tol) throw new Error('矩阵不可逆（行列式为 0）');
    if (p !== i) { [M[i], M[p]] = [M[p], M[i]]; [I[i], I[p]] = [I[p], I[i]]; }
    const piv = M[i][i];
    for (let c = 0; c < n; c++) { M[i][c] /= piv; I[i][c] /= piv; }
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i];
      if (!f) continue;
      for (let c = 0; c < n; c++) { M[r][c] -= f * M[i][c]; I[r][c] -= f * I[i][c]; }
    }
  }
  return I.map(r => r.map(snap));
}

/** 行简化阶梯形；返回 {rref, pivots, rank} */
export function rref(A, {snapValues = true} = {}) {
  const M = clone(A).map(r => r.map(Number));
  const n = M.length, m = M[0].length, tol = eps(M);
  const pivots = [];
  let row = 0;
  for (let col = 0; col < m && row < n; col++) {
    let p = row;
    for (let r = row + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[p][col])) p = r;
    if (Math.abs(M[p][col]) < tol) { for (let r = row; r < n; r++) M[r][col] = 0; continue; }
    [M[row], M[p]] = [M[p], M[row]];
    const piv = M[row][col];
    for (let c = 0; c < m; c++) M[row][c] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === row) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = 0; c < m; c++) M[r][c] -= f * M[row][c];
    }
    pivots.push(col);
    row++;
  }
  const R = snapValues ? M.map(r => r.map(snap)) : M;
  return {rref: R, pivots, rank: pivots.length};
}
export function rank(A) { return rref(A).rank; }

/** 解线性方程组 Ax = b（LU 部分主元，支持多个右端项） */
export function solve(A, b) {
  const n = A.length;
  if (A.some(r => r.length !== n)) throw new Error('solve 需要方阵系数矩阵');
  const bMat = isMatrix(b) ? clone(b) : b.map(x => [x]);
  const M = clone(A).map(r => r.map(Number));
  const X = bMat.map(r => r.map(Number));
  const tol = eps(M);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (Math.abs(M[p][i]) < tol) throw new Error('系数矩阵奇异，无唯一解（可用 rref 看通解）');
    if (p !== i) { [M[i], M[p]] = [M[p], M[i]]; [X[i], X[p]] = [X[p], X[i]]; }
    for (let r = i + 1; r < n; r++) {
      const f = M[r][i] / M[i][i];
      if (!f) continue;
      for (let c = i; c < n; c++) M[r][c] -= f * M[i][c];
      for (let c = 0; c < X[0].length; c++) X[r][c] -= f * X[i][c];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let c = 0; c < X[0].length; c++) {
      let s = X[i][c];
      for (let j = i + 1; j < n; j++) s -= M[i][j] * X[j][c];
      X[i][c] = snap(s / M[i][i]);
    }
  }
  return isMatrix(b) ? X : X.map(r => r[0]);
}

export function lu(A) {
  const n = A.length;
  const L = eye(n), U = clone(A).map(r => r.map(Number)), P = eye(n);
  const tol = eps(U);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(U[r][i]) > Math.abs(U[p][i])) p = r;
    if (Math.abs(U[p][i]) < tol) throw new Error('矩阵奇异，无 LU 分解');
    if (p !== i) { [U[i], U[p]] = [U[p], U[i]]; [P[i], P[p]] = [P[p], P[i]]; for (let c = 0; c < i; c++) [L[i][c], L[p][c]] = [L[p][c], L[i][c]]; }
    for (let r = i + 1; r < n; r++) {
      const f = U[r][i] / U[i][i];
      L[r][i] = f;
      for (let c = i; c < n; c++) U[r][c] -= f * U[i][c];
    }
  }
  return {L, U, P};
}

/** Gram–Schmidt QR */
export function qr(A) {
  const n = A.length, m = A[0].length;
  const Q = zeros(n, m), R = zeros(m, m);
  const cols = transpose(A);
  const qs = [];
  for (let j = 0; j < m; j++) {
    let v = cols[j].slice();
    for (let i = 0; i < qs.length; i++) {
      const r = dot(qs[i], cols[j]);
      R[i][j] = r;
      v = v.map((x, k) => x - r * qs[i][k]);
    }
    const nv = Math.sqrt(dot(v, v));
    R[j][j] = nv;
    const q = nv > 1e-12 ? v.map(x => x / nv) : v.map(() => 0);
    qs.push(q);
    for (let k = 0; k < n; k++) Q[k][j] = q[k];
  }
  return {Q, R: R.map(r => r.map(snap))};
}

/** 零空间的一组基 */
export function nullspace(A) {
  const {rref: R, pivots} = rref(A);
  const m = A[0].length;
  const free = [];
  for (let j = 0; j < m; j++) if (!pivots.includes(j)) free.push(j);
  const basis = [];
  for (const f of free) {
    const v = new Array(m).fill(0);
    v[f] = 1;
    pivots.forEach((pc, i) => { v[pc] = -R[i][f]; });
    basis.push(v.map(snap));
  }
  return basis;
}

// ---------------------------------------------------------------- 复数
const C = {
  add: (a, b) => ({re: a.re + b.re, im: a.im + b.im}),
  sub: (a, b) => ({re: a.re - b.re, im: a.im - b.im}),
  mul: (a, b) => ({re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re}),
  div: (a, b) => {
    const d = b.re * b.re + b.im * b.im;
    return {re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d};
  },
  abs: a => Math.hypot(a.re, a.im),
};
const cplx = re => ({re, im: 0});

/**
 * 特征值：Faddeev–LeVerrier 求特征多项式系数 → Durand–Kerner 求复根
 * 对任意实方阵都适用（含复特征值），n ≤ 10 足够用。
 */
export function eigenvalues(A) {
  const n = A.length;
  if (A.some(r => r.length !== n)) throw new Error('eigen 需要方阵');
  if (n === 1) return [{re: A[0][0], im: 0}];
  // 特征多项式 λ^n + p1 λ^{n-1} + ... + pn
  const p = new Array(n + 1).fill(0);
  p[0] = 1;
  let B = eye(n);
  for (let k = 1; k <= n; k++) {
    B = matmul(A, B);
    const pk = -trace(B) / k;
    p[k] = pk;
    for (let i = 0; i < n; i++) B[i][i] += pk;
  }
  // Durand–Kerner
  let roots = [];
  let seed = {re: 0.4, im: 0.9};
  let cur = {re: 1, im: 0};
  for (let i = 0; i < n; i++) { roots.push(cur); cur = C.mul(cur, seed); }
  const poly = z => { let s = cplx(1); for (let k = 1; k <= n; k++) s = C.add(C.mul(s, z), cplx(p[k])); return s; };
  for (let iter = 0; iter < 400; iter++) {
    let maxd = 0;
    const next = roots.slice();
    for (let i = 0; i < n; i++) {
      let d = cplx(1);
      for (let j = 0; j < n; j++) if (j !== i) d = C.mul(d, C.sub(roots[i], roots[j]));
      if (C.abs(d) < 1e-300) continue;
      const delta = C.div(poly(roots[i]), d);
      next[i] = C.sub(roots[i], delta);
      maxd = Math.max(maxd, C.abs(delta));
    }
    roots = next;
    if (maxd < 1e-12) break;
  }
  roots.sort((a, b) => a.re - b.re || a.im - b.im);
  return roots.map(r => (Math.abs(r.im) < 1e-7 ? {re: snap(r.re), im: 0} : {re: Number(r.re.toFixed(10)), im: Number(r.im.toFixed(10))}));
}
export function eigenvaluesReal(A) {
  const es = eigenvalues(A);
  return es.every(e => Math.abs(e.im) < 1e-9) ? es.map(e => e.re) : null;
}
function maxEigenSymmetric(A) {
  // 2-范数用幂迭代（A 为对称半正定）
  const n = A.length;
  let v = new Array(n).fill(1 / Math.sqrt(n));
  let lam = 0;
  for (let it = 0; it < 500; it++) {
    const w = A.map(row => dot(row, v));
    const nw = Math.sqrt(dot(w, w));
    if (nw < 1e-300) return 0;
    v = w.map(x => x / nw);
    lam = nw;
  }
  return lam;
}
