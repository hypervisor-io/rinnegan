import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GraphStore } from "./store.js";

describe("GraphStore", () => {
  it("persists provenance + retrieves edges and fts", () => {
    const g = GraphStore.open(":memory:");
    g.insertNode({ id: "a", kind: "function", qualifiedName: "login", filePath: "a.ts", language: "ts", startLine: 1, endLine: 3 });
    g.insertNode({ id: "b", kind: "function", qualifiedName: "userSession", filePath: "a.ts", language: "ts", startLine: 5, endLine: 9 });
    g.insertEdge({ source: "a", target: "b", kind: "calls", line: 2, col: 1, provenance: "ast_exact", confidence: 1, resolver: "ts", readWrite: "call" });

    expect(g.outgoing("a")[0].provenance).toBe("ast_exact");
    expect(g.outgoing("a")[0].readWrite).toBe("call");
    expect(g.incoming("b")[0].source).toBe("a");
    expect(g.searchFts("login", 5).map((n) => n.id)).toContain("a");
    // camelCase split: "userSession" indexed under "session"
    expect(g.searchFts("session", 5).map((n) => n.id)).toContain("b");
    g.close();
  });

  it("removeFile prunes nodes and dangling edges", () => {
    const g = GraphStore.open(":memory:");
    g.insertNode({ id: "x", kind: "function", qualifiedName: "f", filePath: "x.ts", language: "ts", startLine: 1, endLine: 2 });
    g.insertNode({ id: "y", kind: "function", qualifiedName: "g", filePath: "y.ts", language: "ts", startLine: 1, endLine: 2 });
    g.insertEdge({ source: "y", target: "x", kind: "calls", line: 1, col: 1, provenance: "ast_exact", confidence: 1, resolver: "ts" });
    g.setFileMeta("x.ts", { hash: "h", mtimeMs: 1, nodeIds: ["x"], role: "library" });

    g.removeFile("x.ts");
    expect(g.getNode("x")).toBeUndefined();
    expect(g.incoming("x")).toHaveLength(0);
    expect(g.outgoing("y").filter((e) => e.target === "x")).toHaveLength(0);
    g.close();
  });

  it("removeFile downgrades a resolved cross-file 'calls' edge back to an unresolved boundary instead of deleting it (F2)", () => {
    const g = GraphStore.open(":memory:");
    g.insertNode({ id: "a_fn", kind: "function", qualifiedName: "charge", filePath: "a.ts", language: "ts", startLine: 1, endLine: 2, isExported: true });
    g.insertNode({ id: "b_fn", kind: "function", qualifiedName: "useIt", filePath: "b.ts", language: "ts", startLine: 1, endLine: 2 });
    // Simulates the post-resolveImports state: a resolved cross-file call.
    g.insertEdge({ source: "b_fn", target: "a_fn", kind: "calls", line: 5, col: 3, provenance: "ast_inferred", confidence: 0.9, resolver: "ts-import", readWrite: "call", metadata: { crossFile: true, module: "./a" } });
    g.setFileMeta("a.ts", { hash: "h", mtimeMs: 1, nodeIds: ["a_fn"], role: "library" });
    g.setFileMeta("b.ts", { hash: "h", mtimeMs: 1, nodeIds: ["b_fn"], role: "library" });

    g.removeFile("a.ts");

    const downgraded = g.outgoing("b_fn").find((e) => e.kind === "calls");
    expect(downgraded).toBeTruthy();
    expect(downgraded!.provenance).toBe("unresolved");
    const placeholder = g.getNode(downgraded!.target);
    expect(placeholder?.qualifiedName).toBe("<unresolved>.charge");
    expect(placeholder?.filePath).toBe("b.ts"); // lives in the caller's file, not the removed file
    expect(placeholder?.kind).toBe("unresolved");
    // Placeholder must go through insertNode so nodes_fts stays consistent.
    expect(g.searchFts("charge", 5).map((n) => n.id)).toContain(downgraded!.target);
    g.close();
  });

  it("removeFile does not wrongly downgrade non-'calls' edges into a shared pseudo node (e.g. manifest package hub)", () => {
    const g = GraphStore.open(":memory:");
    const hubId = "hub_lodash";
    g.insertNode({ id: hubId, kind: "module", qualifiedName: "lodash", filePath: "<packages>", language: "package", startLine: 1, endLine: 1 });
    g.insertNode({ id: "manifestA", kind: "file", qualifiedName: "<file>", filePath: "a/package.json", language: "manifest", startLine: 1, endLine: 1 });
    g.insertNode({ id: "manifestB", kind: "file", qualifiedName: "<file>", filePath: "b/package.json", language: "manifest", startLine: 1, endLine: 1 });
    g.insertEdge({ source: "manifestA", target: hubId, kind: "references", line: 1, col: 1, provenance: "ast_exact", confidence: 1, resolver: "manifest-dep", metadata: { dependsOn: true } });
    g.insertEdge({ source: "manifestB", target: hubId, kind: "references", line: 1, col: 1, provenance: "ast_exact", confidence: 1, resolver: "manifest-dep", metadata: { dependsOn: true } });
    // Mirrors indexer.ts: setFileMeta's node_ids = res.nodes.map(id), which
    // includes the shared hub node under whichever manifest's extraction ran.
    g.setFileMeta("a/package.json", { hash: "h", mtimeMs: 1, nodeIds: ["manifestA", hubId], role: "config" });
    g.setFileMeta("b/package.json", { hash: "h", mtimeMs: 1, nodeIds: ["manifestB"], role: "config" });

    g.removeFile("a/package.json");

    // Pre-existing (out-of-scope) collateral loss of the hub node itself is
    // unchanged by this fix — but critically, B's edge must NOT be rewritten
    // into a bogus "<unresolved>.lodash" placeholder: only "calls" edges are
    // eligible for downgrade, "references"/depends_on edges are not.
    expect(g.getNode(hubId)).toBeUndefined();
    expect(g.outgoing("manifestB")).toHaveLength(0);
    expect(g.allNodes().some((n) => n.qualifiedName.startsWith("<unresolved>"))).toBe(false);
    g.close();
  });

  it("persists file role and lists roles", () => {
    const s = GraphStore.open(":memory:");
    s.setFileMeta("a.ts", { hash: "h", mtimeMs: 1, nodeIds: [], role: "test" });
    expect(s.getFileMeta("a.ts")!.role).toBe("test");
    expect(s.roleByFile().get("a.ts")).toBe("test");
    s.close();
  });

  it("fingerprint pins the sha256(path + NUL + hash + NL, sorted by path) algorithm and is insertion-order independent", () => {
    const expected = createHash("sha256").update("a.ts\0h1\n").update("b.ts\0h2\n").digest("hex");

    const forward = GraphStore.open(":memory:");
    forward.setFileMeta("a.ts", { hash: "h1", mtimeMs: 1, nodeIds: [], role: "library" });
    forward.setFileMeta("b.ts", { hash: "h2", mtimeMs: 1, nodeIds: [], role: "library" });
    expect(forward.fingerprint()).toBe(expected);
    forward.close();

    const reverse = GraphStore.open(":memory:");
    reverse.setFileMeta("b.ts", { hash: "h2", mtimeMs: 1, nodeIds: [], role: "library" });
    reverse.setFileMeta("a.ts", { hash: "h1", mtimeMs: 1, nodeIds: [], role: "library" });
    expect(reverse.fingerprint()).toBe(expected);
    reverse.close();
  });

  it("fingerprint of an empty index is sha256 of empty input", () => {
    const s = GraphStore.open(":memory:");
    expect(s.fingerprint()).toBe(createHash("sha256").update("").digest("hex"));
    s.close();
  });
});
