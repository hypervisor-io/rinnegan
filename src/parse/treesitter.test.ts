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

describe("registry languages", () => {
  it("Rust: resolves in-file function call", async () => {
    const r = await parseFile("a.rs", "fn login(u: &str) -> bool { validate(u) }\nfn validate(u: &str) -> bool { true }", "rust");
    expect(r.nodes.some((n) => n.qualifiedName === "login" && n.kind === "function")).toBe(true);
    expect(r.edges.some((e) => e.kind === "calls" && e.provenance === "ast_exact")).toBe(true);
  });
  it("Java: resolves in-file method call", async () => {
    const r = await parseFile("A.java", "class A { boolean login(String u){ return validate(u); } boolean validate(String u){ return true; } }", "java");
    expect(r.nodes.some((n) => n.qualifiedName.endsWith("validate"))).toBe(true);
    expect(r.edges.some((e) => e.kind === "calls" && e.provenance === "ast_exact")).toBe(true);
  });
  it("Ruby: extracts methods", async () => {
    const r = await parseFile("a.rb", "def login(u)\n validate(u)\nend\ndef validate(u)\n true\nend", "ruby");
    expect(r.nodes.some((n) => n.qualifiedName === "login")).toBe(true);
  });
});
