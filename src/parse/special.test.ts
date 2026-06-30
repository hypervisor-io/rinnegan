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

describe("mcp config extractor", () => {
  it("emits a server node with env requirements and a package ref", async () => {
    const src = JSON.stringify({ mcpServers: { veridex: { command: "npx", args: ["-y", "veridex-mcp"], env: { TOKEN: "x" } } } });
    const r = await parseFile(".mcp.json", src, "mcp");
    const server = r.nodes.find((n) => n.qualifiedName === "server.veridex");
    expect(server).toBeTruthy();
    expect(server!.docstring).toContain("TOKEN");
    expect(r.nodes.some((n) => n.qualifiedName === "veridex-mcp" && n.filePath === "<packages>")).toBe(true);
  });
});
