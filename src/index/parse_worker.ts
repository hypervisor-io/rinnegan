import { parentPort } from "node:worker_threads";
import { parseFile } from "../parse/extract.js";
import type { ParseRequest, ParseResponse } from "./parse_protocol.js";

/**
 * Parse-worker entry. Each worker owns its own parser + tree-sitter wasm state,
 * so nothing is shared with the main thread or other workers. The pool only
 * ever hands a worker one task at a time — a worker is a serial parser, and
 * parallelism comes from having several of them.
 */
if (!parentPort) throw new Error("rinnegan parse_worker must run inside a worker thread");

const port = parentPort;

port.on("message", (req: ParseRequest) => {
  parseFile(req.path, req.content, req.language).then(
    (result) => port.postMessage({ id: req.id, ok: true, result } satisfies ParseResponse),
    // A throwing extractor is that file's problem, not the run's: report it so
    // the main thread can log the same skip line serial indexing logs.
    (err: unknown) =>
      port.postMessage({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies ParseResponse),
  );
});
