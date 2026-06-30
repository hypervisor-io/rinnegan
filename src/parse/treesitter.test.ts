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

describe("extended grammars", () => {
  const cases: [string, string, string, string][] = [
    ["a.c", "int login(char* u){ return validate(u); } int validate(char* u){ return 1; }", "c", "login"],
    ["a.cpp", "class A { public: bool run(){ return go(); } bool go(){ return true; } };", "cpp", "run"],
    ["a.swift", "func login(_ u: String) -> Bool { return validate(u) }\nfunc validate(_ u: String) -> Bool { true }", "swift", "login"],
    ["a.kt", "fun login(u: String): Boolean { return validate(u) }\nfun validate(u: String) = true", "kotlin", "login"],
    ["a.scala", "object M { def login(u: String): Boolean = validate(u); def validate(u: String): Boolean = true }", "scala", "login"],
    ["a.zig", "fn login(u: []const u8) bool { return validate(u); }\nfn validate(u: []const u8) bool { return true; }", "zig", "login"],
    ["a.sol", "contract C { function login() public returns (bool) { return validate(); } function validate() public returns (bool) { return true; } }", "solidity", "login"],
  ];
  for (const [file, src, lang, sym] of cases) {
    it(`${lang}: extracts ${sym}`, async () => {
      const r = await parseFile(file, src, lang);
      expect(r.nodes.some((n) => n.qualifiedName.endsWith(sym))).toBe(true);
    });
  }
  it("c resolves an in-file call (ast_exact)", async () => {
    const r = await parseFile("a.c", "int login(char* u){ return validate(u); } int validate(char* u){ return 1; }", "c");
    expect(r.edges.some((e) => e.kind === "calls" && e.provenance === "ast_exact")).toBe(true);
  });
  it("attributes a call to its enclosing function, not the file", async () => {
    const r = await parseFile("a.go", "package main\nfunc Login() bool { return validate() }\nfunc validate() bool { return true }", "go");
    const call = r.edges.find((e) => e.kind === "calls" && e.provenance === "ast_exact");
    const source = r.nodes.find((n) => n.id === call!.source);
    expect(source?.qualifiedName).toBe("Login"); // not "<file>"
  });
});

describe("elixir", () => {
  const src = [
    "defmodule Math do",
    "  def add(a, b), do: a + b",
    "  def run do",
    "    add(1, 2)",
    "    missing(3)",
    "  end",
    "end",
  ].join("\n");
  it("extracts module + def macros as definitions", async () => {
    const r = await parseFile("math.ex", src, "elixir");
    expect(r.nodes.some((n) => n.qualifiedName === "Math" && n.kind === "module")).toBe(true);
    expect(r.nodes.some((n) => n.qualifiedName === "Math.add" && n.kind === "function")).toBe(true);
    expect(r.nodes.some((n) => n.qualifiedName === "Math.run")).toBe(true);
  });
  it("resolves an in-file def call (ast_exact) and marks unknown calls unresolved", async () => {
    const r = await parseFile("math.ex", src, "elixir");
    const call = r.edges.find((e) => e.kind === "calls" && e.provenance === "ast_exact");
    expect(call).toBeTruthy();
    expect(r.nodes.find((n) => n.id === call!.target)?.qualifiedName).toBe("Math.add");
    expect(r.edges.some((e) => e.kind === "calls" && e.provenance === "unresolved")).toBe(true);
    // the signature `add(a, b)` must NOT become a self-call edge
    expect(r.edges.filter((e) => e.kind === "calls" && e.provenance === "ast_exact").length).toBe(1);
  });
});

describe("ocaml", () => {
  const src = "let add a b = a + b\nlet run () = add 1 2";
  it("extracts let-bindings and resolves an application (ast_exact)", async () => {
    const r = await parseFile("a.ml", src, "ocaml");
    expect(r.nodes.some((n) => n.qualifiedName === "add")).toBe(true);
    const call = r.edges.find((e) => e.kind === "calls" && e.provenance === "ast_exact");
    expect(call).toBeTruthy();
    expect(r.nodes.find((n) => n.id === call!.target)?.qualifiedName).toBe("add");
  });
});

describe("rescript", () => {
  const src = "let add = (a, b) => a + b\nlet run = () => add(1, 2)";
  it("extracts let-bindings and resolves a call (ast_exact)", async () => {
    const r = await parseFile("a.res", src, "rescript");
    expect(r.nodes.some((n) => n.qualifiedName === "add")).toBe(true);
    const call = r.edges.find((e) => e.kind === "calls" && e.provenance === "ast_exact");
    expect(call).toBeTruthy();
    expect(r.nodes.find((n) => n.id === call!.target)?.qualifiedName).toBe("add");
  });
});

describe("bash", () => {
  const src = ["greet() {", "  echo hi", "}", "greet", "ls -la"].join("\n");
  it("extracts function defs", async () => {
    const r = await parseFile("a.sh", src, "bash");
    expect(r.nodes.some((n) => n.qualifiedName === "greet" && n.kind === "function")).toBe(true);
  });
  it("resolves an in-file command invocation (ast_exact) and marks externals unresolved", async () => {
    const r = await parseFile("a.sh", src, "bash");
    const call = r.edges.find((e) => e.kind === "calls" && e.provenance === "ast_exact");
    expect(call).toBeTruthy();
    expect(r.nodes.find((n) => n.id === call!.target)?.qualifiedName).toBe("greet");
    // `ls` is not a function defined in-file → honest unresolved boundary
    expect(r.edges.some((e) => e.kind === "calls" && e.provenance === "unresolved")).toBe(true);
  });
});

describe("objective-c", () => {
  const src = [
    "@interface Foo : NSObject",
    "- (int)bar:(int)x;",
    "@end",
    "@implementation Foo",
    "- (int)bar:(int)x { return [self baz:x]; }",
    "- (int)baz:(int)y { return y; }",
    "@end",
  ].join("\n");
  it("extracts class + methods", async () => {
    const r = await parseFile("Foo.m", src, "objc");
    expect(r.nodes.some((n) => n.qualifiedName.endsWith("Foo") && n.kind === "class")).toBe(true);
    expect(r.nodes.some((n) => n.qualifiedName.endsWith("baz") && n.kind === "method")).toBe(true);
  });
  it("resolves an in-file message send (ast_exact)", async () => {
    const r = await parseFile("Foo.m", src, "objc");
    const call = r.edges.find((e) => e.kind === "calls" && e.provenance === "ast_exact");
    expect(call).toBeTruthy();
    expect(r.nodes.find((n) => n.id === call!.target)?.qualifiedName.endsWith("baz")).toBe(true);
  });
});
