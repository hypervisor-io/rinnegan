import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "../src/graph/store.js";
import { Indexer } from "../src/index/indexer.js";
import { Rinnegan } from "../src/index.js";

const corpus = join(dirname(fileURLToPath(import.meta.url)), "corpus");

async function indexDump(): Promise<string> {
  const s = GraphStore.open(":memory:");
  await new Indexer(s).indexAll(corpus);
  const dump = JSON.stringify({ nodes: s.allNodes(), edges: s.allEdges() });
  s.close();
  return dump;
}

async function sliceText(task: string): Promise<string> {
  const vx = Rinnegan.open(corpus, { dbPath: ":memory:" });
  await vx.indexAll();
  const t = vx.understand(task).text;
  vx.close();
  return t;
}

describe("determinism gates", () => {
  it("the index is byte-identical across runs (no model, no randomness)", async () => {
    const a = await indexDump();
    const b = await indexDump();
    expect(a).toEqual(b);
  });

  it("understand output is identical across runs", async () => {
    const a = await sliceText("process a payment refund");
    const b = await sliceText("process a payment refund");
    expect(a).toEqual(b);
  });
});
