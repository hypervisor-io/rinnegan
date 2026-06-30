/**
 * MCP registration snippets for the major coding agents. Veridex speaks MCP stdio,
 * which every major agent supports; only the config file/format differs. We EMIT
 * ready-to-paste config (non-destructive) rather than silently editing global files.
 */

export interface InstallTarget {
  id: string;
  name: string;
  configPath: string;
  format: "json" | "toml" | "command";
  render(cmd: string, args: string[]): string;
}

const jsonBlock = (cmd: string, args: string[]): string =>
  JSON.stringify({ mcpServers: { veridex: { command: cmd, args } } }, null, 2);

export const TARGETS: InstallTarget[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    configPath: "project .mcp.json  (or run the command)",
    format: "command",
    render: (cmd, args) => `claude mcp add veridex -- ${cmd} ${args.join(" ")}\n\n# or add to .mcp.json:\n${jsonBlock(cmd, args)}`,
  },
  {
    id: "cursor",
    name: "Cursor",
    configPath: "~/.cursor/mcp.json  (global)  or  .cursor/mcp.json (project)",
    format: "json",
    render: jsonBlock,
  },
  {
    id: "windsurf",
    name: "Windsurf",
    configPath: "~/.codeium/windsurf/mcp_config.json",
    format: "json",
    render: jsonBlock,
  },
  {
    id: "codex",
    name: "Codex CLI",
    configPath: "~/.codex/config.toml",
    format: "toml",
    render: (cmd, args) =>
      `[mcp_servers.veridex]\ncommand = "${cmd}"\nargs = [${args.map((a) => `"${a}"`).join(", ")}]`,
  },
  {
    id: "kiro",
    name: "Kiro",
    configPath: ".kiro/settings/mcp.json  (or run the command)",
    format: "command",
    render: (cmd, args) => `kiro-cli mcp add --name veridex -- ${cmd} ${args.join(" ")}\n\n# or .kiro/settings/mcp.json:\n${jsonBlock(cmd, args)}`,
  },
  {
    id: "pi",
    name: "Pi Agent",
    configPath: "~/.pi/mcp.json",
    format: "json",
    render: jsonBlock,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    configPath: "~/.gemini/settings.json",
    format: "json",
    render: jsonBlock,
  },
];

/** Render install instructions for one agent (or all). */
export function renderInstall(agent: string | undefined, cmd: string, args: string[]): string {
  const chosen = agent ? TARGETS.filter((t) => t.id === agent) : TARGETS;
  if (chosen.length === 0) {
    return `Unknown agent "${agent}". Known: ${TARGETS.map((t) => t.id).join(", ")}`;
  }
  return chosen
    .map((t) => `## ${t.name}  (${t.format})\n# config: ${t.configPath}\n${t.render(cmd, args)}`)
    .join("\n\n");
}
