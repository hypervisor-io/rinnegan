import { describe, it, expect } from "vitest";
import { parseFile } from "./extract.js";
import { nodeId } from "../core/types.js";

describe("docs extractor", () => {
  it("turns markdown links and wikilinks into reference edges", async () => {
    const src = "See [guide](./guide.md) and [[architecture]] for details.";
    const r = await parseFile("docs/readme.md", src, "markdown");
    const link = r.edges.find((e) => e.resolver === "docs-link");
    expect(link).toBeTruthy();
    expect(link!.metadata?.target).toMatch(/guide\.md$/);
    expect(r.edges.some((e) => e.resolver === "docs-wiki")).toBe(true);
  });
});

describe("manifest extractor", () => {
  it("package.json deps become canonical package hubs shared across manifests", async () => {
    const a = await parseFile("package.json", JSON.stringify({ dependencies: { commander: "^12" } }), "manifest");
    const b = await parseFile("sub/package.json", JSON.stringify({ devDependencies: { commander: "^12" } }), "manifest");
    const hub = nodeId("<packages>", "commander");
    expect(a.nodes.some((n) => n.id === hub)).toBe(true);
    expect(b.nodes.some((n) => n.id === hub)).toBe(true); // same id → one hub
    expect(a.edges.some((e) => e.resolver === "manifest-dep" && e.target === hub)).toBe(true);
  });

  it("go.mod requires become package hubs", async () => {
    const src = "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n)\n";
    const r = await parseFile("go.mod", src, "manifest");
    expect(r.nodes.some((n) => n.qualifiedName === "github.com/foo/bar")).toBe(true);
  });
});

describe("sfc extractor (vue/svelte/astro)", () => {
  const vue = [
    "<template><div>{{ msg }}</div></template>",
    '<script setup lang="ts">',
    "function greet() { return build(); }",
    "function build() { return 1; }",
    "greet();",
    "</script>",
  ].join("\n");
  it("extracts script-block defs and resolves in-file calls (ast_exact)", async () => {
    const r = await parseFile("App.vue", vue, "vue");
    expect(r.nodes.some((n) => n.qualifiedName === "greet" && n.kind === "function")).toBe(true);
    expect(r.edges.some((e) => e.kind === "calls" && e.provenance === "ast_exact")).toBe(true);
  });
  it("remaps line numbers back to the original file", async () => {
    const r = await parseFile("App.vue", vue, "vue");
    const greet = r.nodes.find((n) => n.qualifiedName === "greet");
    expect(greet?.startLine).toBe(3); // function greet is on physical line 3
  });
  it("handles svelte with no lang attribute", async () => {
    const svelte = ["<script>", "function inc(n) { return n + 1; }", "</script>", "<button>x</button>"].join("\n");
    const r = await parseFile("C.svelte", svelte, "svelte");
    const inc = r.nodes.find((n) => n.qualifiedName === "inc");
    expect(inc?.startLine).toBe(2);
  });
});

describe("terraform extractor", () => {
  const src = [
    'variable "region" { default = "us-east-1" }',
    'resource "aws_instance" "web" {',
    "  ami = var.region",
    "  count = var.missing",
    "}",
    'module "vpc" { source = "./vpc" }',
  ].join("\n");
  it("extracts blocks as label-named definitions", async () => {
    const r = await parseFile("main.tf", src, "terraform");
    expect(r.nodes.some((n) => n.qualifiedName === "variable.region" && n.kind === "variable")).toBe(true);
    expect(r.nodes.some((n) => n.qualifiedName === "resource.aws_instance.web")).toBe(true);
    expect(r.nodes.some((n) => n.qualifiedName === "module.vpc" && n.kind === "module")).toBe(true);
  });
  it("resolves var.* references (ast_exact) and marks unknown refs unresolved", async () => {
    const r = await parseFile("main.tf", src, "terraform");
    const ref = r.edges.find((e) => e.kind === "references" && e.provenance === "ast_exact");
    expect(ref).toBeTruthy();
    expect(r.nodes.find((n) => n.id === ref!.target)?.qualifiedName).toBe("variable.region");
    expect(r.edges.some((e) => e.kind === "references" && e.provenance === "unresolved")).toBe(true);
  });
});

describe("mcp config extractor", () => {
  it("emits a server node with env requirements and a package ref", async () => {
    const src = JSON.stringify({ mcpServers: { rinnegan: { command: "npx", args: ["-y", "rinnegan-mcp"], env: { TOKEN: "x" } } } });
    const r = await parseFile(".mcp.json", src, "mcp");
    const server = r.nodes.find((n) => n.qualifiedName === "server.rinnegan");
    expect(server).toBeTruthy();
    expect(server!.docstring).toContain("TOKEN");
    expect(r.nodes.some((n) => n.qualifiedName === "rinnegan-mcp" && n.filePath === "<packages>")).toBe(true);
  });
});
