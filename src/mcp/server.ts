import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Rinnegan } from "../index.js";
import { VERSION } from "../version.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => string;
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/** Build the tool registry against a Rinnegan instance. */
export function buildTools(vx: Rinnegan): { listed: ToolDef[]; all: ToolDef[] } {
  const understand: ToolDef = {
    name: "understand",
    description:
      "Return the minimal, provenance-tagged signal slice for a task. Call this FIRST. " +
      "Output is Read-equivalent (cite file:line). Only [ast_exact] facts are ground truth.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What you are about to do, in a sentence." },
        budget: { type: "number", description: "Token budget for the slice (default 6000)." },
      },
      required: ["task"],
    },
    handler: (a) => vx.understand(str(a.task), { tokenBudget: typeof a.budget === "number" ? a.budget : undefined }).text,
  };

  const search: ToolDef = {
    name: "search",
    description: "Symbol search (FTS/BM25). Returns locations only.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    handler: (a) => vx.search(str(a.query), 20).map((n) => `${n.filePath}:${n.startLine}  ${n.qualifiedName}  [${n.kind}]`).join("\n") || "(none)",
  };
  const deps: ToolDef = {
    name: "deps",
    description: "File-scoped dependency query: what this file's symbols call/reference out.",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    handler: (a) => vx.deps(str(a.file)).dependencies.map((d) => `${d.name}  [${d.provenance}/${d.kind}]`).join("\n") || "(none)",
  };
  const refs: ToolDef = {
    name: "refs",
    description: "References to a symbol, optionally filtered by read/write.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" }, readWrite: { type: "string", enum: ["read", "write", "readwrite", "call"] } },
      required: ["symbol"],
    },
    handler: (a) => {
      const rw = str(a.readWrite) || undefined;
      const es = vx.refs(str(a.symbol), rw ? { readWrite: rw as never } : {});
      return es.map((e) => `${e.line}  ${e.readWrite}  ${e.provenance}`).join("\n") || "(none)";
    },
  };
  const callers: ToolDef = {
    name: "callers",
    description: "Functions that call a symbol.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    handler: (a) => vx.callers(str(a.symbol)).map((n) => `${n.filePath}:${n.startLine}  ${n.qualifiedName}`).join("\n") || "(none)",
  };
  const impact: ToolDef = {
    name: "impact",
    description: "Blast radius: who is transitively affected by changing a symbol.",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    handler: (a) => vx.impact(str(a.symbol)).map((n) => `${n.filePath}:${n.startLine}  ${n.qualifiedName}`).join("\n") || "(none)",
  };

  const all = [understand, search, deps, refs, callers, impact];
  const exposeAll = process.env.RINNEGAN_MCP_TOOLS === "all";
  return { listed: exposeAll ? all : [understand], all };
}

/** Create the MCP server (low-level Server → spec-correct stdio framing via the SDK). */
export function createServer(vx: Rinnegan): Server {
  const { listed, all } = buildTools(vx);
  const byName = new Map(all.map((t) => [t.name, t]));

  const server = new Server(
    { name: "rinnegan", version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listed.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    try {
      return { content: [{ type: "text", text: tool.handler((req.params.arguments ?? {}) as Record<string, unknown>) }] };
    } catch (e) {
      return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  });

  return server;
}

/** Start the MCP server over stdio for a project root. projectPath is optional by design. */
export async function runMcp(root: string = process.cwd()): Promise<void> {
  const vx = Rinnegan.open(root);
  if (vx.stats().nodes === 0) await vx.indexAll();
  const server = createServer(vx);
  await server.connect(new StdioServerTransport());
}
