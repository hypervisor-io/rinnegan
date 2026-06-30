/**
 * Deterministic truncated SVD via seeded power iteration with Gram–Schmidt
 * deflation and sign canonicalization. No randomness, no external library —
 * the same matrix always yields byte-identical singular vectors.
 *
 * For A (m×n): returns U (m×k), S (k), V (n×k) with A ≈ U diag(S) Vᵀ.
 */

export interface SvdResult {
  u: number[][]; // m × k  (left singular vectors, columns)
  s: number[]; // k
  v: number[][]; // n × k  (right singular vectors, columns)
}

/** Tiny deterministic LCG → vector of length n in [-1, 1). */
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

/** y = Aᵀ(A x), the n×n normal-equation operator applied to x. */
function atAx(A: number[][], x: number[], n: number): number[] {
  const m = A.length;
  const ax = new Array<number>(m).fill(0);
  for (let i = 0; i < m; i++) {
    const row = A[i];
    let s = 0;
    for (let j = 0; j < n; j++) s += row[j] * x[j];
    ax[i] = s;
  }
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i++) {
    const row = A[i];
    const a = ax[i];
    for (let j = 0; j < n; j++) out[j] += row[j] * a;
  }
  return out;
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

export function truncatedSvd(
  A: number[][],
  k: number,
  opts: { seed?: number; iters?: number } = {},
): SvdResult {
  const seed = opts.seed ?? 1;
  const iters = opts.iters ?? 128;
  const m = A.length;
  const n = m > 0 ? A[0].length : 0;
  const kk = Math.min(k, n, m);

  const vs: number[][] = [];
  const us: number[][] = [];
  const ss: number[] = [];

  for (let c = 0; c < kk; c++) {
    let x = seededVector(n, seed + c * 7919);
    // orthogonalize against found right vectors, then normalize
    for (const vj of vs) x = subtractProjection(x, vj);
    let nx = norm(x);
    x = nx === 0 ? seededVector(n, seed + c + 1) : scale(x, 1 / nx);

    for (let it = 0; it < iters; it++) {
      let y = atAx(A, x, n);
      for (const vj of vs) y = subtractProjection(y, vj);
      nx = norm(y);
      if (nx === 0) break;
      x = scale(y, 1 / nx);
    }

    // singular value: ||A x||
    const ax = new Array<number>(m).fill(0);
    for (let i = 0; i < m; i++) ax[i] = dot(A[i], x);
    const sigma = norm(ax);
    const sign = canonicalizeSign(x);
    const v = scale(x, sign);
    const u = sigma === 0 ? new Array<number>(m).fill(0) : scale(ax, (1 / sigma) * sign);

    vs.push(v);
    us.push(u);
    ss.push(roundStable(sigma));
  }

  // assemble column-major: u[i][c], v[j][c]
  const U = Array.from({ length: m }, (_, i) => us.map((u) => roundStable(u[i])));
  const V = Array.from({ length: n }, (_, j) => vs.map((v) => roundStable(v[j])));
  return { u: U, s: ss, v: V };
}

function subtractProjection(x: number[], v: number[]): number[] {
  const c = dot(x, v);
  return x.map((xi, i) => xi - c * v[i]);
}

/** Round to 12 significant decimals to kill last-bit float jitter — keeps determinism robust. */
function roundStable(x: number): number {
  if (!isFinite(x)) return 0;
  return Math.round(x * 1e12) / 1e12;
}
