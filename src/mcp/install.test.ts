import { describe, it, expect } from "vitest";
import { renderInstall, TARGETS } from "./install.js";

describe("MCP install snippets", () => {
  it("covers the major agents", () => {
    const ids = TARGETS.map((t) => t.id);
    for (const a of ["claude-code", "cursor", "codex", "kiro", "pi"]) expect(ids).toContain(a);
  });

  it("renders a valid JSON block for cursor", () => {
    const out = renderInstall("cursor", "rinnegan", ["mcp"]);
    const json = out.slice(out.indexOf("{"));
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers.rinnegan.command).toBe("rinnegan");
    expect(parsed.mcpServers.rinnegan.args).toEqual(["mcp"]);
  });

  it("renders TOML for codex and a command for claude-code", () => {
    expect(renderInstall("codex", "rinnegan", ["mcp"])).toContain("[mcp_servers.rinnegan]");
    expect(renderInstall("claude-code", "rinnegan", ["mcp"])).toContain("claude mcp add rinnegan");
  });

  it("lists all agents when none specified", () => {
    const out = renderInstall(undefined, "rinnegan", ["mcp"]);
    expect(out).toContain("Cursor");
    expect(out).toContain("Codex");
  });
});
