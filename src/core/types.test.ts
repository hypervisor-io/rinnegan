import { describe, it, expect } from "vitest";
import { nodeId, PROVENANCE_TRUST } from "./types.js";

describe("core types", () => {
  it("nodeId is deterministic and path-sensitive", () => {
    expect(nodeId("a.ts", "Foo.bar")).toBe(nodeId("a.ts", "Foo.bar"));
    expect(nodeId("a.ts", "Foo.bar")).not.toBe(nodeId("b.ts", "Foo.bar"));
    expect(nodeId("a.ts", "Foo.bar")).not.toBe(nodeId("a.ts", "Foo.baz"));
  });

  it("ast_exact is full trust, unresolved is zero", () => {
    expect(PROVENANCE_TRUST.ast_exact).toBe(1);
    expect(PROVENANCE_TRUST.unresolved).toBe(0);
    expect(PROVENANCE_TRUST.ast_inferred).toBeGreaterThan(PROVENANCE_TRUST.heuristic);
    expect(PROVENANCE_TRUST.heuristic).toBeGreaterThan(PROVENANCE_TRUST.latent);
  });
});
