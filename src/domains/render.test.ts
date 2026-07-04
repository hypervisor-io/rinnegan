import { describe, it, expect } from "vitest";
import { renderMapMarkdown, renderMapMermaid, type MapResult } from "./render.js";

const RESULT: MapResult = {
  domains: [
    {
      name: "src/auth",
      label: "auth",
      files: ["src/auth/login.ts", "src/auth/token.ts"],
      entrypoints: [],
      topSymbols: [
        { name: "login", file: "src/auth/login.ts", line: 2 },
        { name: "mintTok", file: "src/auth/token.ts", line: 1 },
      ],
    },
    {
      name: "src/billing",
      label: "billing",
      files: ["src/billing/charge.ts"],
      entrypoints: ["main.ts"],
      topSymbols: [{ name: "chargeCard", file: "src/billing/charge.ts", line: 2 }],
    },
  ],
  edges: [{ from: "src/billing", to: "src/auth", fromLabel: "billing", toLabel: "auth", weight: 3 }],
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

  it("emits no parenthetical name suffixes when no domain names collide", () => {
    const text = renderMapMarkdown(RESULT);
    const depLine = text.split("\n").find((l) => l.includes("→"))!;
    expect(depLine).toBe("src/billing → src/auth (3)");
  });

  it("disambiguates dependency-line names with a suffix only when names actually collide", () => {
    const collided: MapResult = {
      domains: [
        { name: "src", label: "d1", files: ["src/d1/b.ts"], entrypoints: [], topSymbols: [] },
        { name: "src", label: "d2", files: ["src/d2/c.ts"], entrypoints: [], topSymbols: [] },
      ],
      edges: [{ from: "src", to: "src", fromLabel: "d1", toLabel: "d2", weight: 1 }],
    };
    const text = renderMapMarkdown(collided);
    const depLine = text.split("\n").find((l) => l.includes("→"))!;
    expect(depLine).toBe("src → src (2) (1)");
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

  it("routes a cross-domain edge between the two distinct node ids, not a self-loop, under a name collision", () => {
    const collided: MapResult = {
      domains: [
        { name: "src", label: "d1", files: ["src/d1/b.ts"], entrypoints: [], topSymbols: [] },
        { name: "src", label: "d2", files: ["src/d2/c.ts"], entrypoints: [], topSymbols: [] },
      ],
      edges: [{ from: "src", to: "src", fromLabel: "d1", toLabel: "d2", weight: 1 }],
    };
    const text = renderMapMermaid(collided);
    const nodeLines = text.split("\n").filter((l) => l.includes('["src"]'));
    expect(nodeLines).toHaveLength(2);
    const ids = nodeLines.map((l) => l.trim().split("[")[0]);
    expect(new Set(ids).size).toBe(2); // sanitized ids stay distinct despite the name collision

    const edgeLine = text.split("\n").find((l) => l.includes("-->"))!;
    const [from, to] = edgeLine.trim().split(" -->|1| ");
    // This is the regression pin: the edge must connect the d1 node to the d2
    // node — not collapse into a self-loop on whichever "src" id came first.
    expect(from).toBe(ids[0]);
    expect(to).toBe(ids[1]);
    expect(from).not.toBe(to);
  });
});
