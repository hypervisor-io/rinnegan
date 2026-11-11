import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { GraphStore } from "../graph/store.js";
import { Indexer } from "./indexer.js";

/**
 * Serial parse-failure behavior. `parseFile` is swapped for a spy that throws on
 * a marked source, so a broken extractor/grammar can be simulated for one file:
 * it must log the historical skip line, keep no entry for that file, and never
 * touch its neighbors or abort the run. (The parallel path reports the same
 * failure through ParseTaskError — see parse_pool.test.ts.)
 */
const THROW_MARKER = "SYNTHETIC_PARSE_THROW";

vi.mock("../parse/extract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parse/extract.js")>();
  return {
    ...actual,
    parseFile: async (path: string, source: string, language: string) => {
      if (source.includes(THROW_MARKER)) throw new Error("synthetic grammar failure");
      return actual.parseFile(path, source, language);
    },
  };
});

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-idx-err-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  dirs.push(dir);
  return dir;
}

/** Rewrite a fixture file and bump its mtime so gate 1 cannot mask the change. */
function touch(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
  const t = Date.now() + 5000;
  utimesSync(join(dir, name), new Date(t), new Date(t));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Indexer parse failures (serial)", () => {
  it("skips only the unparseable file, logging the historical skip line", async () => {
    const root = fixture({
      "ok.ts": "export function fine() { return 1 }",
      "boom.ts": `export function bad() { return 2 } // ${THROW_MARKER}`,
    });
    const store = GraphStore.open(":memory:");
    const stats = await new Indexer(store).indexAll(root, { jobs: 1 });

    expect(stats.scanned).toBe(2);
    expect(stats.parsed).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(console.error).toHaveBeenCalledWith("rinnegan index: parse failed, file skipped: boom.ts (synthetic grammar failure)");

    // The skipped file records no meta, so the next run retries it; its
    // neighbor is untouched by the failure.
    expect(store.getFileMeta("boom.ts")).toBeUndefined();
    expect(store.getFileMeta("ok.ts")).toBeDefined();
    expect(store.allNodes().some((n) => n.filePath === "boom.ts")).toBe(false);
    expect(store.allNodes().some((n) => n.filePath === "ok.ts")).toBe(true);

    expect((await new Indexer(store).sync(root)).reindexed).toBe(0);
    store.close();
  });

  it("a file that was indexed and then stops parsing keeps no stale entry", async () => {
    const root = fixture({ "a.ts": "export function first() { return 1 }" });
    const store = GraphStore.open(":memory:");
    const ix = new Indexer(store);
    await ix.indexAll(root, { jobs: 1 });
    expect(store.getFileMeta("a.ts")).toBeDefined();
    expect(store.allNodes().some((n) => n.qualifiedName === "first")).toBe(true);

    touch(root, "a.ts", `export function second() { return 2 } // ${THROW_MARKER}`);
    expect((await ix.sync(root)).reindexed).toBe(0);

    // Old nodes and meta are gone (the pre-parallel contract for a failure), so
    // the graph never claims to describe bytes it could not parse.
    expect(store.getFileMeta("a.ts")).toBeUndefined();
    expect(store.allNodes().some((n) => n.filePath === "a.ts")).toBe(false);
    // …and a fixed file comes straight back on the next sweep.
    touch(root, "a.ts", "export function third() { return 3 }");
    expect((await ix.sync(root)).reindexed).toBe(1);
    expect(store.allNodes().some((n) => n.qualifiedName === "third")).toBe(true);
    store.close();
  });
});
