import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ParseResult } from "../parse/extract.js";
import type { ParseRequest, ParseResponse, ParseTask } from "./parse_protocol.js";

/**
 * A single file's parse threw inside a worker. The indexer treats this exactly
 * like the serial path does — log the skip line and index nothing for that file
 * — so a broken grammar can never abort a whole index run.
 */
export class ParseTaskError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ParseTaskError";
  }
}

interface Job {
  req: ParseRequest;
  resolve: (result: ParseResult) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  current: Job | null;
}

interface WorkerEntry {
  url: URL;
  /** True when the entry is TypeScript (src/tsx/vitest runs) and needs a resolve hook. */
  source: boolean;
}

/**
 * Resolve a relative `./x.js` specifier to `./x.ts` when the compiled file is
 * absent. Only the source-mode worker needs this (tsconfig NodeNext writes
 * `.js` specifiers for `.ts` files); a built dist resolves everything natively.
 */
const SOURCE_RESOLVE_HOOK = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      return next(specifier.slice(0, -3) + ".ts", context);
    }
    throw err;
  }
}
`;

function workerEntry(): WorkerEntry {
  const compiled = new URL("./parse_worker.js", import.meta.url);
  if (existsSync(fileURLToPath(compiled))) return { url: compiled, source: false };
  return { url: new URL("./parse_worker.ts", import.meta.url), source: true };
}

/** ESM bootstrap that teaches the worker to load the TypeScript sources directly. */
function sourceBootstrap(entry: URL): URL {
  const hook = "data:text/javascript," + encodeURIComponent(SOURCE_RESOLVE_HOOK);
  const code = [
    `import { register } from "node:module";`,
    `register(${JSON.stringify(hook)});`,
    `await import(${JSON.stringify(entry.href)});`,
  ].join("\n");
  return new URL("data:text/javascript," + encodeURIComponent(code));
}

/**
 * Bounded pool of parse workers. Tasks are queued and handed out one per idle
 * worker; results may come back in any order (the indexer commits them in file
 * order, so completion order never reaches the store).
 *
 * Failure policy: a worker that dies rejects its in-flight task *and* every
 * queued task with one fatal error, and later `run()` calls reject immediately —
 * never a hang, never a silently shrinking pool.
 */
export class ParsePool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 0;
  private fatal: Error | null = null;
  private closed = false;

  private constructor(
    private readonly maxSize: number,
    private readonly script: URL,
  ) {}

  /**
   * Create a pool of at most `size` workers (at least 1). Workers are spawned
   * lazily as the backlog requires, so a small run never pays for a full set of
   * parser/wasm startups it cannot use. Throws if a worker cannot start.
   */
  static create(size: number): ParsePool {
    const entry = workerEntry();
    const pool = new ParsePool(Math.max(1, size), entry.source ? sourceBootstrap(entry.url) : entry.url);
    pool.spawn();
    return pool;
  }

  /** Parse one file on a free worker. Rejects with ParseTaskError when only that file's parse failed. */
  run(task: ParseTask): Promise<ParseResult> {
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.closed) return Promise.reject(new Error("rinnegan parse pool is closed"));
    return new Promise<ParseResult>((resolve, reject) => {
      this.queue.push({ req: { ...task, id: this.nextId++ }, resolve, reject });
      this.dispatch();
    });
  }

  /** Terminate every worker. Idempotent; queued tasks already rejected. */
  async close(): Promise<void> {
    if (this.closed && this.slots.length === 0) return;
    this.closed = true;
    this.rejectQueued(new Error("rinnegan parse pool closed before the task ran"));
    const stopping = this.slots.map((s) => {
      s.worker.removeAllListeners();
      return s.worker.terminate();
    });
    this.slots = [];
    await Promise.all(stopping).catch(() => {
      // terminate() rejecting on an already-dead worker is not an error worth surfacing
    });
  }

  private spawn(): void {
    const worker = new Worker(this.script);
    const slot: Slot = { worker, current: null };
    worker.on("message", (msg: ParseResponse) => this.onMessage(slot, msg));
    worker.on("error", (err: Error) => this.failAll(err));
    worker.on("exit", (code: number) => {
      if (!this.closed && this.slots.includes(slot)) {
        this.failAll(new Error(`rinnegan parse worker exited unexpectedly (code ${code})`));
      }
    });
    this.slots.push(slot);
  }

  private onMessage(slot: Slot, msg: ParseResponse): void {
    const job = slot.current;
    if (!job) return; // reply from a task we already gave up on (the slot is idle or gone)
    if (job.req.id !== msg.id) {
      // Never leave a worker marked busy on a reply we cannot match: that is a hang.
      this.failAll(new Error(`rinnegan parse worker answered task ${msg.id} while running ${job.req.id}`));
      return;
    }
    slot.current = null;
    if (msg.ok) job.resolve(msg.result);
    else job.reject(new ParseTaskError(job.req.path, msg.error));
    this.dispatch();
  }

  private dispatch(): void {
    for (;;) {
      const free = this.slots.find((s) => !s.current);
      if (free) {
        const job = this.queue.shift();
        if (!job) return;
        free.current = job;
        free.worker.postMessage(job.req);
        continue;
      }
      // Every worker is busy and work is waiting: grow toward the cap.
      if (this.queue.length > 0 && this.slots.length < this.maxSize) {
        this.spawn();
        continue;
      }
      return;
    }
  }

  /** One dead worker kills the pool: reject everything still outstanding, then stop. */
  private failAll(err: Error): void {
    if (this.fatal) return;
    this.fatal = err;
    this.rejectQueued(err); // queued + in-flight, while the slots still know their current job
    const slots = this.slots;
    this.slots = [];
    for (const s of slots) {
      s.worker.removeAllListeners();
      s.worker.terminate().catch(() => {
        // the worker may already be gone — nothing to clean up
      });
    }
  }

  private rejectQueued(err: Error): void {
    for (const job of this.queue.splice(0)) job.reject(err);
    for (const slot of this.slots) {
      const job = slot.current;
      if (!job) continue;
      slot.current = null;
      job.reject(err);
    }
  }
}
