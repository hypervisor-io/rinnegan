import { describe, it, expect } from "vitest";
import { parseFile } from "./extract.js";

describe("tree-sitter extractors", () => {
  it("Python: resolves in-file calls (ast_exact) and marks attribute calls as boundaries", async () => {
    const src = [
      "def login(u):",
      "    return validate(u)",
      "def validate(u):",
      "    return len(u) > 0",
    ].join("\n");
    const r = await parseFile("a.py", src, "python");
    expect(r.nodes.some((n) => n.qualifiedName === "login" && n.kind === "function")).toBe(true);
    expect(r.nodes.some((n) => n.qualifiedName === "validate")).toBe(true);
    const call = r.edges.find((e) => e.kind === "calls" && e.provenance === "ast_exact");
    expect(call).toBeTruthy();
    // len() is a builtin not defined in-file → honest unresolved boundary
    expect(r.edges.some((e) => e.kind === "calls" && e.provenance === "unresolved")).toBe(true);
  });

  it("Go: resolves in-file function calls", async () => {
    const src = [
      "package main",
      "func Login(u string) bool { return validate(u) }",
      "func validate(u string) bool { return len(u) > 0 }",
    ].join("\n");
    const r = await parseFile("a.go", src, "go");
    expect(r.nodes.some((n) => n.qualifiedName === "Login")).toBe(true);
    const call = r.edges.find((e) => e.kind === "calls" && e.provenance === "ast_exact");
    expect(call).toBeTruthy();
    const target = r.nodes.find((n) => n.id === call!.target);
    expect(target?.qualifiedName).toBe("validate");
  });
});
