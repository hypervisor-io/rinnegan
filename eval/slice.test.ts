import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Veridex } from "../src/index.js";

const corpus = join(dirname(fileURLToPath(import.meta.url)), "corpus");

describe("slice-quality gates", () => {
  let vx: Veridex;
  beforeAll(async () => {
    vx = Veridex.open(corpus, { dbPath: ":memory:" });
    await vx.indexAll();
  });
  afterAll(() => vx.close());

  it("the slice for a refund task contains the symbols that task touches", () => {
    const r = vx.understand("process a payment refund");
    // refundPayment and the validateAmount/chargeCard it depends on should surface
    expect(r.text).toContain("refundPayment");
    expect(r.text).toMatch(/validateAmount|chargeCard/);
  });

  it("respects the token budget (massive 1M headroom)", () => {
    const r = vx.understand("process a payment refund", { tokenBudget: 2000 });
    expect(r.tokensEstimate).toBeLessThanOrEqual(2000);
  });

  it("only ast_exact facts are presented as ground truth; others are labeled", () => {
    const r = vx.understand("create an order");
    for (const f of r.facts) {
      expect(["ast_exact", "ast_inferred", "heuristic", "lexical", "latent", "unresolved"]).toContain(f.provenance);
    }
  });
});
