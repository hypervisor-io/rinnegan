import { readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { availableParallelism } from "node:os";
import { GraphStore } from "../graph/store.js";
import { scanFiles, contentHash, LANG_EXT, type ScannedFile } from "../ingest/scanner.js";
import { parseFile, ANALYZER_VERSION } from "../parse/extract.js";
import { resolveImports } from "../resolution/imports.js";
import { classifyFile, buildClassifyContext, type ClassifyContext } from "../ingest/classify.js";
import { ParsePool, ParseTaskError } from "./parse_pool.js";
import type { ParseResult } from "../parse/extract.js";

export interface IndexStats {
  scanned: number;
  parsed: number;
  skipped: number;
  nodes: number;
  edges: number;
}

export interface SyncStats { reindexed: number; removed: number }

export interface IndexOpts {
  /**
   * Parse-worker count. 1 forces the serial fast path (no worker threads at
   * all). Omitted means `defaultJobs()`. Clamped to 1..MAX_EXPLICIT_JOBS.
   */
  jobs?: number;
}

/** Ceiling for the default worker count — more than this mostly buys startup cost. */
const MAX_DEFAULT_JOBS = 8;
/** Absolute sanity ceiling for an explicit `--jobs` (still clamped, never a fork bomb). */
const MAX_EXPLICIT_JOBS = 64;
/** Files dispatched ahead of the commit cursor: 4x jobs of work keeps workers fed without buffering the repo. */
const WINDOW_PER_JOB = 4;

/** Default parallelism: one worker fewer than the machine, clamped to 1..MAX_DEFAULT_JOBS. */
export function defaultJobs(): number {
  return Math.max(1, Math.min(MAX_DEFAULT_JOBS, availableParallelism() - 1));
}

/** Turn an optional caller-supplied jobs value into a usable worker count. */
export function resolveJobs(jobs?: number): number {
  if (jobs === undefined || !Number.isFinite(jobs)) return defaultJobs();
  return Math.max(1, Math.min(MAX_EXPLICIT_JOBS, Math.floor(jobs)));
}

/** A file whose gates and parse are done; committing it is the only store write left. */
type Staged =
  | { kind: "skipped" }
  /** Its parse threw: the commit drops whatever the file had indexed before (the historical behavior). */
  | { kind: "failed"; file: ScannedFile }
  | { kind: "parsed"; file: ScannedFile; content: string; hash: string; mtimeMs: number; res: ParseResult };

/**
 * Orchestrates scan → two-gate change detection → parse → atomic persist.
 * Deterministic: files are dispatched and committed in sorted order, inserts
 * batched per file. With `jobs > 1` only *parsing* is parallel — workers come
 * back in any order and the main thread commits them in file order, so the
 * resulting graph is byte-identical to a serial run.
 */
export class Indexer {
  constructor(private store: GraphStore) {}

  async indexAll(root: string, opts: IndexOpts = {}): Promise<IndexStats> {
    const files = scanFiles(root);
    const ctx = buildClassifyContext(root, files.filter((f) => f.language === "manifest").map((f) => f.path));
    const jobs = resolveJobs(opts.jobs);
    // Nothing to overlap with fewer than two files — always take the serial path then.
    const { parsed, skipped } =
      jobs > 1 && files.length > 1
        ? await this.indexParallel(root, files, ctx, jobs)
        : await this.indexSerial(root, files, ctx);
    // cross-file pass once all files are present
    this.store.tx(() => resolveImports(this.store));
    const s = this.store.stats();
    return { scanned: files.length, parsed, skipped, nodes: s.nodes, edges: s.edges };
  }

  private async indexSerial(root: string, files: ScannedFile[], ctx: ClassifyContext): Promise<{ parsed: number; skipped: number }> {
    let parsed = 0;
    let skipped = 0;
    for (const f of files) {
      if (await this.indexOne(root, f, ctx)) parsed++;
      else skipped++;
    }
    return { parsed, skipped };
  }

  /**
   * Parallel parse, serial commit. Up to `WINDOW_PER_JOB * jobs` files are in
   * flight; the oldest staged result is committed whenever the window fills, so
   * memory holds a bounded slice of the repo and never all of its ParseResults.
   */
  private async indexParallel(
    root: string,
    files: ScannedFile[],
    ctx: ClassifyContext,
    jobs: number,
  ): Promise<{ parsed: number; skipped: number }> {
    const pool = ParsePool.create(Math.min(jobs, files.length));
    const window = WINDOW_PER_JOB * jobs;
    const staged = new Map<number, Promise<Staged>>();
    let cursor = 0;
    let parsed = 0;
    let skipped = 0;

    const commitOldest = async (): Promise<void> => {
      const i = cursor++;
      const pending = staged.get(i)!;
      staged.delete(i);
      if (this.commitStaged(await pending, ctx)) parsed++;
      else skipped++;
    };

    try {
      for (let i = 0; i < files.length; i++) {
        staged.set(i, this.stageFile(pool, root, files[i]));
        if (staged.size >= window) await commitOldest();
      }
      while (cursor < files.length) await commitOldest();
    } finally {
      // A stage that rejects after we stopped committing (e.g. a rethrow out of
      // commitOldest) must not surface as an unhandled rejection.
      for (const pending of staged.values()) void pending.catch(() => {});
      await pool.close();
    }
    return { parsed, skipped };
  }

  /** Index one file with two-gate change detection. Returns true if (re)parsed. */
  private async indexOne(root: string, f: ScannedFile, ctx: ClassifyContext): Promise<boolean> {
    return this.commitStaged(await this.stageFile(null, root, f), ctx);
  }

  /**
   * Gates + content read + parse for one file. Mutates nothing except the
   * gate-2 meta refresh (same row, fresher mtime), so it is safe to run ahead
   * of the commit cursor and off the main thread (pool given) or inline (null).
   */
  private async stageFile(pool: ParsePool | null, root: string, f: ScannedFile): Promise<Staged> {
    const abs = join(root, f.path);
    const st = statSync(abs);
    const meta = this.store.getFileMeta(f.path);
    // Both gates also require the file to have been analyzed at the current
    // ANALYZER_VERSION; a stale version means the stored nodes/edges came from
    // older parse logic and must be regenerated even if the bytes are identical.
    const fresh = meta?.analyzerVersion === ANALYZER_VERSION;

    if (meta && fresh && meta.mtimeMs === st.mtimeMs) return { kind: "skipped" }; // gate 1
    const content = readFileSync(abs, "utf8");
    const hash = contentHash(content);
    if (meta && fresh && meta.hash === hash) {
      this.store.setFileMeta(f.path, { hash, mtimeMs: st.mtimeMs, nodeIds: meta.nodeIds, role: meta.role, analyzerVersion: ANALYZER_VERSION });
      return { kind: "skipped" }; // gate 2
    }

    let res: ParseResult;
    try {
      res = pool ? await pool.run({ path: f.path, language: f.language, content }) : await parseFile(f.path, content, f.language);
    } catch (e) {
      // A pool/worker failure is infrastructure, not this file's grammar — let
      // it abort the run with its own clear error instead of skipping silently.
      if (pool && !(e instanceof ParseTaskError)) throw e;
      // One unparseable file must not abort the whole index (e.g. a grammar/
      // runtime mismatch in one tree-sitter wasm). Record nothing, so the file
      // is retried on the next run; the index stays consistent. Log and move on.
      console.error(`rinnegan index: parse failed, file skipped: ${f.path} (${e instanceof Error ? e.message : String(e)})`);
      return { kind: "failed", file: f };
    }
    return { kind: "parsed", file: f, content, hash, mtimeMs: st.mtimeMs, res };
  }

  /**
   * Persist one staged file: drop its old nodes/edges, classify its role, write
   * nodes/edges/imports/body tokens atomically, record its meta. Main thread
   * only, always in sorted file-path order.
   */
  private commitStaged(st: Staged, ctx: ClassifyContext): boolean {
    if (st.kind === "skipped") return false;
    if (st.kind === "failed") {
      // A file that no longer parses keeps no entry: no stale nodes, no meta, so
      // the next run retries it (matches the pre-parallel contract).
      this.store.removeFile(st.file.path);
      return false;
    }
    const f = st.file;
    // No-op when the file had no meta yet (fresh index or a previously skipped file).
    this.store.removeFile(f.path);
    const role = classifyFile(f.path, st.content, f.language, st.res.imports.map((i) => i.moduleSpec), ctx);
    this.store.tx(() => {
      for (const n of st.res.nodes) this.store.insertNode(n);
      for (const e of st.res.edges) this.store.insertEdge(e);
      this.store.setImports(f.path, st.res.imports);
      // Index-time artifact, not semantic-model state: the file's BODY tokens
      // give query time a file-level BM25 prior (store.fileRelevance).
      this.store.setFileTokens(f.path, st.content);
    });
    this.store.setFileMeta(f.path, {
      hash: st.hash,
      mtimeMs: st.mtimeMs,
      nodeIds: st.res.nodes.map((n) => n.id),
      role,
      analyzerVersion: ANALYZER_VERSION,
    });
    return true;
  }

  /**
   * Reconcile index with the working tree: reindex changed/new files, remove
   * deleted ones, refresh cross-file edges only if anything moved. Cheap when
   * nothing changed (scan + one stat per file — gate 1). Serial by design: the
   * incremental sweep rarely has more than a handful of files to reparse.
   */
  async sync(root: string): Promise<SyncStats> {
    const scanned = scanFiles(root);
    const ctx = buildClassifyContext(root, scanned.filter((f) => f.language === "manifest").map((f) => f.path));
    const onDisk = new Set(scanned.map((f) => f.path));
    let removed = 0;
    for (const path of this.store.allFilePaths()) {
      if (!onDisk.has(path)) { this.store.removeFile(path); removed++; }
    }
    let reindexed = 0;
    for (const f of scanned) if (await this.indexOne(root, f, ctx)) reindexed++;
    if (reindexed + removed > 0) this.store.tx(() => resolveImports(this.store));
    return { reindexed, removed };
  }

  /** Re-index a single file (or remove it if gone), then refresh cross-file edges. */
  async reindexPath(root: string, relPath: string): Promise<"reindexed" | "removed" | "skipped"> {
    const language = LANG_EXT[extname(relPath).toLowerCase()];
    if (!language) return "skipped";
    const abs = join(root, relPath);
    if (!existsSync(abs)) {
      this.store.removeFile(relPath);
      this.store.tx(() => resolveImports(this.store));
      return "removed";
    }
    const st = statSync(abs);
    const scanned = scanFiles(root);
    const ctx = buildClassifyContext(root, scanned.filter((f) => f.language === "manifest").map((f) => f.path));
    const changed = await this.indexOne(root, { path: relPath, size: st.size, language }, ctx);
    this.store.tx(() => resolveImports(this.store));
    return changed ? "reindexed" : "skipped";
  }
}
