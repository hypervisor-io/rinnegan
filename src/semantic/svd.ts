/**
 * Deterministic truncated SVD via seeded power iteration with Gram–Schmidt
 * deflation and sign canonicalization. No randomness, no external library —
 * the same matrix always yields byte-identical singular vectors.
 *
 * Operates on a SPARSE column representation so it scales to thousands of symbols
 * (real TF-IDF matrices are ~99% zeros). For A (rows×cols): returns U (rows×k),
 * S (k), V (cols×k) with A ≈ U diag(S) Vᵀ.
 */

export interface SparseMatrix {
  rows: number;
  cols: number;
  /** colData[c] = list of {row, val} nonzeros in column c */
  colData: { row: number; val: number }[][];
}

export interface SvdResult {
  u: number[][]; // rows × k
  s: number[]; // k
  v: number[][]; // cols × k
}

/** Build a SparseMatrix from a dense array (test/convenience helper). */
export function denseToSparse(A: number[][]): SparseMatrix {
  const rows = A.length;
  const cols = rows > 0 ? A[0].length : 0;
  const colData: { row: number; val: number }[][] = Array.from({ length: cols }, () => []);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (A[i][j] !== 0) colData[j].push({ row: i, val: A[i][j] });
    }
  }
  return { rows, cols, colData };
}

function seededVector(n: number, seed: number): number[] {
  let state = (seed >>> 0) || 1;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    out[i] = (state / 0xffffffff) * 2 - 1;
  }
  return out;
}
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}
function scale(a: number[], k: number): number[] {
  return a.map((x) => x * k);
}

/** A·x over sparse columns: result length = rows. x length = cols. */
function aTimes(A: SparseMatrix, x: number[]): number[] {
  const out = new Array<number>(A.rows).fill(0);
  for (let c = 0; c < A.cols; c++) {
    const xc = x[c];
    if (xc === 0) continue;
    for (const { row, val } of A.colData[c]) out[row] += val * xc;
  }
  return out;
}

/** Aᵀ·y over sparse columns: result length = cols. y length = rows. */
function atTimes(A: SparseMatrix, y: number[]): number[] {
  const out = new Array<number>(A.cols).fill(0);
  for (let c = 0; c < A.cols; c++) {
    let s = 0;
    for (const { row, val } of A.colData[c]) s += val * y[row];
    out[c] = s;
  }
  return out;
}

/** y = Aᵀ(A x), the cols×cols normal-equation operator applied to x (length cols). */
function atAx(A: SparseMatrix, x: number[]): number[] {
  return atTimes(A, aTimes(A, x));
}

function canonicalizeSign(v: number[]): number {
  let idx = 0;
  let max = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]);
    if (a > max) {
      max = a;
      idx = i;
    }
  }
  return v[idx] < 0 ? -1 : 1;
}
function subtractProjection(x: number[], v: number[]): number[] {
  const c = dot(x, v);
  return x.map((xi, i) => xi - c * v[i]);
}
function roundStable(x: number): number {
  if (!isFinite(x)) return 0;
  return Math.round(x * 1e12) / 1e12;
}

export function truncatedSvd(
  A: SparseMatrix,
  k: number,
  opts: { seed?: number; iters?: number } = {},
): SvdResult {
  const seed = opts.seed ?? 1;
  const iters = opts.iters ?? 64;
  const m = A.rows;
  const n = A.cols;
  const kk = Math.min(k, n, m);

  const vs: number[][] = [];
  const us: number[][] = [];
  const ss: number[] = [];

  for (let c = 0; c < kk; c++) {
    let x = seededVector(n, seed + c * 7919);
    for (const vj of vs) x = subtractProjection(x, vj);
    let nx = norm(x);
    x = nx === 0 ? seededVector(n, seed + c + 1) : scale(x, 1 / nx);

    for (let it = 0; it < iters; it++) {
      let y = atAx(A, x);
      for (const vj of vs) y = subtractProjection(y, vj);
      nx = norm(y);
      if (nx === 0) break;
      x = scale(y, 1 / nx);
    }

    const ax = aTimes(A, x);
    const sigma = norm(ax);
    const sign = canonicalizeSign(x);
    const v = scale(x, sign);
    const u = sigma === 0 ? new Array<number>(m).fill(0) : scale(ax, (1 / sigma) * sign);

    vs.push(v);
    us.push(u);
    ss.push(roundStable(sigma));
  }

  const U = Array.from({ length: m }, (_, i) => us.map((u) => roundStable(u[i])));
  const V = Array.from({ length: n }, (_, j) => vs.map((v) => roundStable(v[j])));
  return { u: U, s: ss, v: V };
}
