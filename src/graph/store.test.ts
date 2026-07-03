import { describe, it, expect } from "vitest";
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
  });

  it("persists file role and lists roles", () => {
    const s = GraphStore.open(":memory:");
    s.setFileMeta("a.ts", { hash: "h", mtimeMs: 1, nodeIds: [], role: "test" });
    expect(s.getFileMeta("a.ts")!.role).toBe("test");
    expect(s.roleByFile().get("a.ts")).toBe("test");
  });
});
