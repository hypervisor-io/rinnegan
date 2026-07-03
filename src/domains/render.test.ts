import { describe, it, expect } from "vitest";
import { renderMapMarkdown, renderMapMermaid, type MapResult } from "./render.js";

const RESULT: MapResult = {
  domains: [
    {
      name: "src/auth",
      files: ["src/auth/login.ts", "src/auth/token.ts"],
      entrypoints: [],
      topSymbols: [
        { name: "login", file: "src/auth/login.ts", line: 2 },
        { name: "mintTok", file: "src/auth/token.ts", line: 1 },
      ],
    },
    {
      name: "src/billing",
      files: ["src/billing/charge.ts"],
      entrypoints: ["main.ts"],
      topSymbols: [{ name: "chargeCard", file: "src/billing/charge.ts", line: 2 }],
    },
  ],
  edges: [{ from: "src/billing", to: "src/auth", weight: 3 }],
};

describe("renderMapMarkdown", () => {
  it("emits a header, top symbols, and an entrypoints line only when a domain has entrypoints", () => {
    const text = renderMapMarkdown(RESULT);
    expect(text).toContain("## src/auth");
    expect(text).toContain("## src/billing");
    expect(text).toContain("entrypoints: main.ts");
    // src/auth has no entrypoints — no stray "entrypoints:" line for it
    const authSection = text.slice(text.indexOf("## src/auth"), text.indexOf("## src/billing"));
    expect(authSection).not.toContain("entrypoints:");
    expect(text).toContain("- login — src/auth/login.ts:2");
    expect(text).toContain("- chargeCard — src/billing/charge.ts:2");
  });

  it("emits a dependencies section with arrow lines carrying the weight", () => {
    const text = renderMapMarkdown(RESULT);
    expect(text).toContain("## dependencies");
    expect(text).toContain("src/billing → src/auth (3)");
  });
});

describe("renderMapMermaid", () => {
  it("starts with flowchart LR and has one edge line per DomainEdge", () => {
    const text = renderMapMermaid(RESULT);
    const lines = text.split("\n");
    expect(lines[0]).toBe("flowchart LR");
    const edgeLines = lines.filter((l) => l.includes("-->"));
    expect(edgeLines).toHaveLength(RESULT.edges.length);
    expect(edgeLines[0]).toContain("|3|");
  });

  it("sanitizes node ids to [A-Za-z0-9_] while keeping the display label verbatim", () => {
    const text = renderMapMermaid(RESULT);
    const nodeLine = text.split("\n").find((l) => l.includes('["src/auth"]'))!;
    expect(nodeLine).toBeTruthy();
    const id = nodeLine.trim().split("[")[0];
    expect(id).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it("tolerates two domains sharing a display name — distinct nodes, no crash", () => {
    const collided: MapResult = {
      domains: [
        { name: "src", files: ["src/d1/b.ts"], entrypoints: [], topSymbols: [] },
        { name: "src", files: ["src/d2/c.ts"], entrypoints: [], topSymbols: [] },
      ],
      edges: [{ from: "src", to: "src", weight: 1 }],
    };
    const text = renderMapMermaid(collided);
    const nodeLines = text.split("\n").filter((l) => l.includes('["src"]'));
    expect(nodeLines).toHaveLength(2);
    const ids = nodeLines.map((l) => l.trim().split("[")[0]);
    expect(new Set(ids).size).toBe(2); // sanitized ids stay distinct despite the name collision
    expect(text).toContain("-->|1|");
  });
});
