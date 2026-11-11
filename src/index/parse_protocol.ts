import type { ParseResult } from "../parse/extract.js";

/**
 * Wire protocol between the indexer's worker pool and a parse worker. Only the
 * inputs `parseFile` needs cross the boundary; the worker returns the whole
 * ParseResult and the main thread does every write (see index/indexer.ts).
 */
export interface ParseTask {
  path: string;
  language: string;
  /** File bytes, read once on the main thread (the change-detection hash uses them too). */
  content: string;
}

export interface ParseRequest extends ParseTask {
  id: number;
}

/**
 * Worker → main. `ok: false` is a *parse* failure (one grammar/extractor threw):
 * the indexer logs it and skips that file, exactly like the serial path. Pool or
 * worker failures are signalled by the thread itself erroring, not by this shape.
 */
export type ParseResponse =
  | { id: number; ok: true; result: ParseResult }
  | { id: number; ok: false; error: string };
