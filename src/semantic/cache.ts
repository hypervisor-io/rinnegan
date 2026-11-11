import type { Bm25State } from "./bm25.js";
import type { LsaState } from "./lsa.js";

/**
 * Deterministic binary serialization of the semantic model.
 *
 * The whole point of this file is that the same corpus yields the same bytes and
 * the same bytes yield the same scores in any process. So: fixed field order, no
 * timestamps, no host info, no map iteration order — only arrays in index order
 * plus little-endian Float32/Uint32 blobs.
 *
 * Container: magic "RNGSEM01", the format version, then two self-describing
 * sections.
 *   0..8    magic (8 ASCII bytes)
 *   8       u32 version   (SEMANTIC_CACHE_VERSION — bumping it invalidates every row)
 *   12      u32 lsa byte length
 *   16      u32 bm25 byte length
 *   20..    lsa section, bm25 section
 *
 * LSA section ("RNGLSAL1"): header JSON {version,kind,k,terms,docs,vocab,idf},
 *   the doc ids joined by "\n", then u (terms×k) and docLatent (docs×k) as
 *   little-endian Float32.
 *
 * BM25 section ("RNGBM251"): header JSON {version,kind,docs,nTokens,dict}, the
 *   doc ids joined by "\n", then the per-doc token-id stream and its offsets as
 *   little-endian Uint32.
 *
 * Floats/ints are always written little-endian, so a big-endian host still
 * produces the canonical layout (it byte-swaps on the way in and out). Any
 * mismatch — version, magic, truncation, a count that disagrees with its header —
 * is a cache miss and the caller rebuilds; a partial model is never served.
 */
export const SEMANTIC_CACHE_VERSION = 1;

const CONTAINER_MAGIC = "RNGSEM01";
const LSA_MAGIC = "RNGLSAL1";
const BM25_MAGIC = "RNGBM251";
const SECTION_PREFIX = 24;
const CONTAINER_PREFIX = 20;
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export interface SemanticModelState {
  lsa: LsaState;
  bm25: Bm25State;
}

interface LsaHeader {
  version: number;
  kind: "lsa";
  k: number;
  terms: number;
  docs: number;
  vocab: string[];
  idf: number[];
}

interface Bm25Header {
  version: number;
  kind: "bm25";
  docs: number;
  nTokens: number;
  dict: string[];
}

export function serializeModel(state: SemanticModelState): Buffer {
  const lsa = serializeLsa(state.lsa);
  const bm25 = serializeBm25(state.bm25);
  const out = Buffer.allocUnsafe(CONTAINER_PREFIX + lsa.length + bm25.length);
  out.write(CONTAINER_MAGIC, 0, 8, "latin1");
  out.writeUInt32LE(SEMANTIC_CACHE_VERSION, 8);
  out.writeUInt32LE(lsa.length, 12);
  out.writeUInt32LE(bm25.length, 16);
  lsa.copy(out, CONTAINER_PREFIX);
  bm25.copy(out, CONTAINER_PREFIX + lsa.length);
  return out;
}

/** Parse a persisted model, or `undefined` on any mismatch (then: rebuild). */
export function deserializeModel(payload: Buffer): SemanticModelState | undefined {
  try {
    if (payload.length < CONTAINER_PREFIX) return undefined;
    if (payload.toString("latin1", 0, 8) !== CONTAINER_MAGIC) return undefined;
    if (payload.readUInt32LE(8) !== SEMANTIC_CACHE_VERSION) return undefined;
    const lsaLen = payload.readUInt32LE(12);
    const bm25Len = payload.readUInt32LE(16);
    if (CONTAINER_PREFIX + lsaLen + bm25Len !== payload.length) return undefined;

    const lsa = deserializeLsa(payload.subarray(CONTAINER_PREFIX, CONTAINER_PREFIX + lsaLen));
    const bm25 = deserializeBm25(payload.subarray(CONTAINER_PREFIX + lsaLen));
    if (!lsa || !bm25) return undefined;
    // The two halves index the same documents in the same order by construction.
    if (lsa.ids.length !== bm25.ids.length) return undefined;
    for (let i = 0; i < lsa.ids.length; i++) if (lsa.ids[i] !== bm25.ids[i]) return undefined;
    return { lsa, bm25 };
  } catch {
    return undefined;
  }
}

// --- LSA section -----------------------------------------------------------

function serializeLsa(state: LsaState): Buffer {
  const terms = state.vocab.length;
  const docs = state.ids.length;
  const header = Buffer.from(
    JSON.stringify({
      version: SEMANTIC_CACHE_VERSION,
      kind: "lsa",
      k: state.k,
      terms,
      docs,
      vocab: state.vocab,
      idf: state.idf,
    } satisfies LsaHeader),
    "utf8",
  );
  const idBlob = Buffer.from(state.ids.join("\n"), "utf8");
  const uBytes = state.u.length * 4;
  const docBytes = state.docLatent.length * 4;

  const out = Buffer.allocUnsafe(SECTION_PREFIX + header.length + idBlob.length + uBytes + docBytes);
  out.write(LSA_MAGIC, 0, 8, "latin1");
  out.writeUInt32LE(header.length, 8);
  out.writeUInt32LE(idBlob.length, 12);
  out.writeUInt32LE(state.u.length, 16);
  out.writeUInt32LE(state.docLatent.length, 20);
  header.copy(out, SECTION_PREFIX);
  let off = SECTION_PREFIX + header.length;
  idBlob.copy(out, off);
  off += idBlob.length;
  writeFloats(out, off, state.u);
  off += uBytes;
  writeFloats(out, off, state.docLatent);
  return out;
}

function deserializeLsa(payload: Buffer): LsaState | undefined {
  if (payload.length < SECTION_PREFIX) return undefined;
  if (payload.toString("latin1", 0, 8) !== LSA_MAGIC) return undefined;
  const headerLen = payload.readUInt32LE(8);
  const idLen = payload.readUInt32LE(12);
  const uCount = payload.readUInt32LE(16);
  const docCount = payload.readUInt32LE(20);
  const idStart = SECTION_PREFIX + headerLen;
  if (idStart + idLen > payload.length) return undefined;

  const h = JSON.parse(payload.toString("utf8", SECTION_PREFIX, idStart)) as LsaHeader;
  if (h.version !== SEMANTIC_CACHE_VERSION || h.kind !== "lsa") return undefined;
  if (!Number.isInteger(h.k) || h.k < 0) return undefined;
  if (!Number.isInteger(h.terms) || !Number.isInteger(h.docs)) return undefined;
  if (uCount !== h.terms * h.k || docCount !== h.docs * h.k) return undefined;
  if (!Array.isArray(h.vocab) || h.vocab.length !== h.terms) return undefined;
  if (!Array.isArray(h.idf) || h.idf.length !== h.terms) return undefined;

  const uStart = idStart + idLen;
  const docStart = uStart + uCount * 4;
  if (docStart + docCount * 4 !== payload.length) return undefined;

  const ids = h.docs === 0 ? [] : payload.toString("utf8", idStart, uStart).split("\n");
  if (ids.length !== h.docs) return undefined;

  return {
    ids,
    vocab: h.vocab,
    idf: h.idf,
    k: h.k,
    u: floatView(payload, uStart, uCount),
    docLatent: floatView(payload, docStart, docCount),
  };
}

// --- BM25 section ----------------------------------------------------------

function serializeBm25(state: Bm25State): Buffer {
  const docs = state.ids.length;
  const header = Buffer.from(
    JSON.stringify({
      version: SEMANTIC_CACHE_VERSION,
      kind: "bm25",
      docs,
      nTokens: state.tokenIds.length,
      dict: state.tokens,
    } satisfies Bm25Header),
    "utf8",
  );
  const idBlob = Buffer.from(state.ids.join("\n"), "utf8");
  const tokBytes = state.tokenIds.length * 4;
  const offBytes = state.offsets.length * 4;

  const out = Buffer.allocUnsafe(SECTION_PREFIX + header.length + idBlob.length + tokBytes + offBytes);
  out.write(BM25_MAGIC, 0, 8, "latin1");
  out.writeUInt32LE(header.length, 8);
  out.writeUInt32LE(idBlob.length, 12);
  out.writeUInt32LE(state.tokenIds.length, 16);
  out.writeUInt32LE(state.offsets.length, 20);
  header.copy(out, SECTION_PREFIX);
  let off = SECTION_PREFIX + header.length;
  idBlob.copy(out, off);
  off += idBlob.length;
  writeU32s(out, off, state.tokenIds);
  off += tokBytes;
  writeU32s(out, off, state.offsets);
  return out;
}

function deserializeBm25(payload: Buffer): Bm25State | undefined {
  if (payload.length < SECTION_PREFIX) return undefined;
  if (payload.toString("latin1", 0, 8) !== BM25_MAGIC) return undefined;
  const headerLen = payload.readUInt32LE(8);
  const idLen = payload.readUInt32LE(12);
  const tokCount = payload.readUInt32LE(16);
  const offCount = payload.readUInt32LE(20);
  const idStart = SECTION_PREFIX + headerLen;
  if (idStart + idLen > payload.length) return undefined;

  const h = JSON.parse(payload.toString("utf8", SECTION_PREFIX, idStart)) as Bm25Header;
  if (h.version !== SEMANTIC_CACHE_VERSION || h.kind !== "bm25") return undefined;
  if (!Number.isInteger(h.docs) || !Number.isInteger(h.nTokens)) return undefined;
  if (!Array.isArray(h.dict)) return undefined;
  if (tokCount !== h.nTokens || offCount !== h.docs + 1) return undefined;

  const tokStart = idStart + idLen;
  const offStart = tokStart + tokCount * 4;
  if (offStart + offCount * 4 !== payload.length) return undefined;

  const ids = h.docs === 0 ? [] : payload.toString("utf8", idStart, tokStart).split("\n");
  if (ids.length !== h.docs) return undefined;

  const starts = u32View(payload, offStart, offCount);
  if (starts[0] !== 0 || starts[offCount - 1] !== tokCount) return undefined;

  return { ids, tokens: h.dict, tokenIds: u32View(payload, tokStart, tokCount), offsets: starts };
}

// --- byte codecs -----------------------------------------------------------

/** Canonical little-endian bytes for a float array, written in place. */
function writeFloats(out: Buffer, offset: number, a: Float32Array): void {
  if (LE && a.byteOffset % 4 === 0) {
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(out, offset);
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if (LE) out.writeFloatLE(a[i], offset + i * 4);
    else out.writeFloatBE(a[i], offset + i * 4);
  }
}

/** Canonical little-endian bytes for a uint32 array, written in place. */
function writeU32s(out: Buffer, offset: number, a: Uint32Array): void {
  if (LE && a.byteOffset % 4 === 0) {
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(out, offset);
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if (LE) out.writeUInt32LE(a[i], offset + i * 4);
    else out.writeUInt32BE(a[i], offset + i * 4);
  }
}

/**
 * Zero-copy Float32 view over the payload when alignment allows; otherwise copy
 * into a fresh, aligned buffer. Either way the values are identical.
 */
function floatView(payload: Buffer, offset: number, count: number): Float32Array {
  const bytes = payload.subarray(offset, offset + count * 4);
  if (!LE) bytes.swap32();
  if ((payload.byteOffset + offset) % 4 === 0) {
    return new Float32Array(payload.buffer, payload.byteOffset + offset, count);
  }
  return new Float32Array(new Uint8Array(bytes).buffer, 0, count);
}

/** Same deal for Uint32. */
function u32View(payload: Buffer, offset: number, count: number): Uint32Array {
  const bytes = payload.subarray(offset, offset + count * 4);
  if (!LE) bytes.swap32();
  if ((payload.byteOffset + offset) % 4 === 0) {
    return new Uint32Array(payload.buffer, payload.byteOffset + offset, count);
  }
  return new Uint32Array(new Uint8Array(bytes).buffer, 0, count);
}
