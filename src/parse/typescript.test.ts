import { describe, it, expect } from "vitest";
import { parseFile } from "./extract.js";

describe("TS extractor", () => {
  it("resolves calls (ast_exact) and tags read/write", async () => {
    const src = `function helper(){ return 1 } function main(){ let x = helper(); x = x + 1; return x }`;
    const r = await parseFile("a.ts", src, "typescript");

    const call = r.edges.find((e) => e.kind === "calls" && e.provenance === "ast_exact");
    expect(call).toBeTruthy();

    const writes = r.edges.filter((e) => e.kind === "references" && e.readWrite === "write");
    const reads = r.edges.filter((e) => e.kind === "references" && e.readWrite === "read");
    expect(writes.length).toBeGreaterThan(0);
    expect(reads.length).toBeGreaterThan(0);
  });

  it("inner scope shadows outer (the #1079 fix)", async () => {
    const src = `
function helper(){ return 1 }
function main(){
  const helper = () => 2;
  return helper();
}`;
    const r = await parseFile("a.ts", src, "typescript");
    const call = r.edges.find((e) => e.kind === "calls" && e.provenance === "ast_exact");
    expect(call).toBeTruthy();
    const target = r.nodes.find((n) => n.id === call!.target);
    // must resolve to the LOCAL const helper (main.helper), not the top-level helper
    expect(target?.qualifiedName).toBe("main.helper");
  });

  it("unresolved callee becomes an honest boundary node", async () => {
    const src = `function main(){ return missingFn() }`;
    const r = await parseFile("a.ts", src, "typescript");
    const u = r.edges.find((e) => e.kind === "calls" && e.provenance === "unresolved");
    expect(u).toBeTruthy();
    expect(r.unresolved).toBeGreaterThan(0);
    expect(r.nodes.find((n) => n.id === u!.target)?.kind).toBe("unresolved");
  });
});
