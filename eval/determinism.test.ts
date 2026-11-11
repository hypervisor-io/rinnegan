import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/graph/store.js";
import { Indexer } from "../src/index/indexer.js";
import { Rinnegan } from "../src/index.js";

const corpus = join(dirname(fileURLToPath(import.meta.url)), "corpus");

async function indexDump(jobs: number): Promise<string> {
  const s = GraphStore.open(":memory:");
  await new Indexer(s).indexAll(corpus, { jobs });
  const dump = JSON.stringify({ nodes: s.allNodes(), edges: s.allEdges() });
  s.close();
  return dump;
}

async function sliceText(task: string): Promise<string> {
  const vx = Rinnegan.open(corpus, { dbPath: ":memory:" });
  await vx.indexAll({ jobs: 1 });
  const t = vx.understand(task).text;
  vx.close();
  return t;
}

describe("determinism gates", () => {
  it("the index is byte-identical across runs and across worker counts (no model, no randomness)", async () => {
    const serial = await indexDump(1);
    expect(await indexDump(1)).toEqual(serial);
    // Parallel parse + ordered commit: completion order must never reach the store.
    expect(await indexDump(3)).toEqual(serial);
  });

  it("understand output is identical across runs", async () => {
    const a = await sliceText("process a payment refund");
    const b = await sliceText("process a payment refund");
    expect(a).toEqual(b);
  });
});
