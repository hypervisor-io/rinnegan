import { describe, it, expect } from "vitest";
import type { Worker } from "node:worker_threads";
import { parseFile } from "../parse/extract.js";
import { ParsePool } from "./parse_pool.js";

/** White-box view of the pool's worker slots (used only to simulate a dying worker). */
function slots(pool: ParsePool): { worker: Worker; current: unknown }[] {
  return (pool as unknown as { slots: { worker: Worker; current: unknown }[] }).slots;
}

describe("ParsePool", () => {
  it("parses tasks on workers with the same results as the serial parser", async () => {
    const pool = ParsePool.create(2);
    const tasks = [
      { path: "a.ts", language: "typescript", content: "export function a(){ return 1 }" },
      { path: "b.py", language: "python", content: "def b():\n    return 1\n" },
      { path: "c.sh", language: "bash", content: "c() {\n  echo hi\n}\nc\n" },
    ];
    const fromPool = await Promise.all(tasks.map((t) => pool.run(t)));
    const serial = [];
    for (const t of tasks) serial.push(await parseFile(t.path, t.content, t.language));
    await pool.close();

    // Structured-clone round trip must not change the graph the main thread commits.
    expect(fromPool).toEqual(serial);
    expect(fromPool[0].nodes.some((n) => n.qualifiedName === "a")).toBe(true);
    expect(fromPool[1].nodes.some((n) => n.qualifiedName === "b")).toBe(true);
  });

  it("rejects the in-flight task with a clear error when a worker dies, instead of hanging", async () => {
    const pool = ParsePool.create(1);
    const pending = pool.run({ path: "a.ts", language: "typescript", content: "export function a(){ return 1 }" });
    pending.catch(() => {}); // the assertion below still sees the rejection; this stops an unhandled-rejection race
    expect(slots(pool)).toHaveLength(1);
    void slots(pool)[0].worker.terminate();

    await expect(pending).rejects.toThrow(/rinnegan parse worker|terminate/i);
    // the pool is poisoned: further work fails fast rather than queueing forever
    await expect(pool.run({ path: "b.ts", language: "typescript", content: "export function b(){}" })).rejects.toThrow();
    await pool.close();
  });

  it("close() rejects tasks that never ran", async () => {
    const pool = ParsePool.create(1);
    const first = pool.run({ path: "a.ts", language: "typescript", content: "export function a(){}" });
    const queued = pool.run({ path: "b.ts", language: "typescript", content: "export function b(){}" });
    // close() rejects both; observe those rejections up front so the test never
    // reports an unhandled rejection in between.
    first.catch(() => {});
    queued.catch(() => {});
    await pool.close();

    await expect(queued).rejects.toThrow(/closed/i);
    await first.catch(() => {}); // may finish or be cut off by the close — either way it must not hang
  });
});
